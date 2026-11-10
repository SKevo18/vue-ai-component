import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AttachmentRecord } from "./attachment-store";
import type { ImageContent } from "./types";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const PASTE_ATTACHMENT_THRESHOLD = 12000;
const IMAGE_SIDE = 1536;
const IMAGE_BYTES = 512 * 1024;
const MAX_IMAGE_PIXELS = 64_000_000;

export type AttachmentErrorCode = "tooLarge" | "unsupported" | "invalid" | "pdfUnavailable";

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

/** pdfjs data files (`cmaps/`, `standard_fonts/`, `wasm/`) live below assetsUrl */
export interface PdfOptions {
  workerSrc: string | URL;
  assetsUrl?: string | URL;
}

let pdfOptions: PdfOptions | null = null;

export function configurePdf(options: PdfOptions | null): void {
  pdfOptions = options;
}

function invalid(message: string): never {
  throw new AttachmentError("invalid", message);
}

function checkSize(blob: Blob): void {
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("tooLarge", "Attachments must be at most 20 MiB.");
}

const decodedText = new WeakMap<Blob, Promise<string>>();

export function textOf(blob: Blob): Promise<string> {
  let promise = decodedText.get(blob);
  if (!promise) {
    promise = (async () => {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer());
      } catch {
        throw new AttachmentError("unsupported", "The file is not valid UTF-8 text.");
      }
      if (/[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/.test(text)) throw new AttachmentError("unsupported", "Binary files cannot be read as text.");
      return text;
    })();
    decodedText.set(blob, promise);
  }
  return promise;
}

export function rasterMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

function jpegOrientation(bytes: Uint8Array, start: number, end: number): number {
  if (end - start < 14 || String.fromCharCode(...bytes.subarray(start, start + 6)) !== "Exif\0\0") return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start + 6, end - start - 6);
  const little = view.getUint16(0) === 0x4949;
  if ((!little && view.getUint16(0) !== 0x4d4d) || view.getUint16(2, little) !== 42) return 1;
  const directory = view.getUint32(4, little);
  if (directory + 2 > view.byteLength) return 1;
  const count = view.getUint16(directory, little);
  for (let i = 0; i < count; i++) {
    const at = directory + 2 + i * 12;
    if (at + 12 > view.byteLength) break;
    if (view.getUint16(at, little) === 0x112 && view.getUint16(at + 2, little) === 3 && view.getUint32(at + 4, little) === 1) return view.getUint16(at + 8, little);
  }
  return 1;
}

/** applies the JPEG orientation and refuses oversized images before decoding */
export function rasterSize(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  if (mime === "image/png" && bytes.length >= 24) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mime === "image/gif" && bytes.length >= 10) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (mime === "image/webp" && bytes.length >= 25) {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8X" && bytes.length >= 30) {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else if (mime === "image/jpeg") {
    let orientation = 1;
    for (let at = 2; at + 3 < bytes.length; ) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if (marker === 0xe1) orientation = jpegOrientation(bytes, at + 2, at + length);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
      }
      at += length;
    }
    if (orientation >= 5 && orientation <= 8) [width, height] = [height, width];
  }
  if (!width || !height) invalid("The image has an invalid or unsupported header.");
  if (width * height > MAX_IMAGE_PIXELS) throw new AttachmentError("tooLarge", "Images must contain at most 64 megapixels.");
  return { width, height };
}

function fit(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, IMAGE_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function imageBitmap(blob: Blob, mime: string): Promise<ImageBitmap> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (rasterMime(bytes) !== mime) invalid("The image format does not match its content.");
  const original = rasterSize(bytes, mime);
  const size = fit(original.width, original.height);
  try {
    return await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
  } catch {
    invalid("The browser cannot decode this image. The file may be corrupt.");
  }
}

const PDF_FOLDERS: Record<string, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" };

/** pdfjs data requests go only to the configured assets folder, never to URLs a document names */
class PdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const folder = PDF_FOLDERS[kind];
    if (!folder || !pdfOptions?.assetsUrl || !/^[\w.-]+$/.test(filename)) invalid("The PDF requested an unsupported resource.");
    const response = await fetch(new URL(`${folder}/${filename}`, new URL(String(pdfOptions.assetsUrl), location.href)), { credentials: "omit" });
    if (!response.ok) invalid("A PDF resource could not be loaded.");
    return new Uint8Array(await response.arrayBuffer());
  }
}

async function withPdf<T>(blob: Blob, use: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  if (!pdfOptions) throw new AttachmentError("pdfUnavailable", "PDF support is not configured in this app.");
  // pdfjs is large and only needed once a PDF is attached, so the app bundles it as a separate chunk
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = String(pdfOptions.workerSrc);
  const task = pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    stopAtErrors: true,
    enableXfa: false,
    useWorkerFetch: false,
    BinaryDataFactory: PdfData,
    useSystemFonts: !pdfOptions.assetsUrl,
    canvasMaxAreaInBytes: IMAGE_SIDE * IMAGE_SIDE * 4,
  });
  try {
    const pdf = await task.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) invalid("The PDF has no readable pages.");
    // no viewer, annotation layer or scripting sandbox is created, so actions and links never run
    return await use(pdf);
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    if (error instanceof Error && error.name === "PasswordException") invalid("Password-protected PDFs are not supported. Attach an unlocked copy.");
    invalid("The PDF could not be read. It may be corrupt or use an unsupported feature.");
  } finally {
    await task.destroy();
  }
}

export async function inspectAttachment(file: File): Promise<Pick<AttachmentRecord, "name" | "mimeType" | "size" | "kind" | "blob">> {
  checkSize(file);
  const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const mime = rasterMime(bytes);
  if (mime) {
    rasterSize(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()), mime);
    return { name: file.name, mimeType: mime, size: file.size, kind: "image", blob: file };
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name) || String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") {
    await withPdf(file, async (pdf) => (await pdf.getPage(1)).cleanup());
    return { name: file.name, mimeType: "application/pdf", size: file.size, kind: "pdf", blob: file };
  }
  if (/\.(?:png|jpe?g|webp|gif)$/i.test(file.name) || ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) invalid("The file is not a valid image.");
  await textOf(file);
  const mimeType = file.type.startsWith("text/") || /^(?:application\/(?:json|xml|javascript)|image\/svg\+xml)$/.test(file.type) ? file.type : "text/plain";
  return { name: file.name, mimeType, size: file.size, kind: "text", blob: file };
}

function joined(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter((part) => typeof part === "string").join("") : "";
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function renderOutput(output: Record<string, unknown>): string {
  if (output.output_type === "stream") return joined(output.text);
  if (output.output_type === "error") {
    const traceback = Array.isArray(output.traceback) ? output.traceback.filter((line) => typeof line === "string") : [];
    return [`${joined(output.ename)}: ${joined(output.evalue)}`, ...traceback].join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  }
  const data = fields(output.data);
  const plain = "text/plain" in data ? joined(data["text/plain"]) : null;
  const markers = Object.keys(data)
    .filter((mime) => mime !== "text/plain" && (plain === null || mime.startsWith("image/")))
    .map((mime) => `[${mime} output]`);
  const text = [...(plain === null ? [] : [plain]), ...markers].join("\n");
  return text.length > 2000 ? `${text.slice(0, 1400)}\n... ${text.length - 1900} characters omitted ...\n${text.slice(-500)}` : text;
}

export function renderNotebook(name: string, notebook: unknown): string | null {
  const cells = fields(notebook).cells;
  if (!Array.isArray(cells)) return null;
  const metadata = fields(fields(notebook).metadata);
  const language = joined(fields(metadata.kernelspec).language) || joined(fields(metadata.language_info).name);
  const parts = [`Notebook ${name}: ${cells.length} cells (${language || "unknown"}). Images are omitted.`];
  cells.forEach((value, index) => {
    const cell = fields(value);
    const type = cell.cell_type === "markdown" || cell.cell_type === "code" ? cell.cell_type : "raw";
    const source = joined(cell.source);
    const lines = [`## [${index}] ${type}`];
    if (type === "code") {
      const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      lines.push(fence + language, source, fence);
      const outputs = Array.isArray(cell.outputs) ? cell.outputs.map((output) => `Output:\n${renderOutput(fields(output))}`) : [];
      if (outputs.length) lines.push(outputs.join("\n"));
    } else lines.push(source.replace(/data:([\w.+-]+\/[\w.+-]+);base64,[A-Za-z0-9+/=]+/g, "data:$1;base64,..."));
    parts.push(lines.join("\n"));
  });
  return parts.join("\n\n");
}

export async function attachmentContent(record: AttachmentRecord, uri: string, page = 1): Promise<{ name: string; mimeType: string; text?: string; image?: { uri: string; page?: number }; page?: number; pages?: number }> {
  checkSize(record.blob);
  const base = { name: record.name, mimeType: record.mimeType };
  if (record.kind === "pdf") {
    return withPdf(record.blob, async (pdf) => {
      if (page > pdf.numPages) throw new RangeError(`page must be between 1 and ${pdf.numPages}.`);
      const pdfPage = await pdf.getPage(page);
      try {
        const content = await pdfPage.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
        return { ...base, text, page, pages: pdf.numPages, image: { uri, page } };
      } finally {
        pdfPage.cleanup();
      }
    });
  }
  if (page !== 1) throw new RangeError("Only PDFs have pages. Continue text with offset instead.");
  if (record.kind === "image") return { ...base, image: { uri } };
  const raw = await textOf(record.blob);
  if (!/\.ipynb$/i.test(record.name)) return { ...base, text: raw };
  try {
    return { ...base, text: renderNotebook(record.name, JSON.parse(raw)) ?? raw };
  } catch {
    return { ...base, text: raw };
  }
}

async function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  let quality = 0.85;
  for (;;) {
    const { promise, resolve, reject } = Promise.withResolvers<Blob>();
    canvas.toBlob((result) => (result ? resolve(result) : reject(new AttachmentError("invalid", "The image could not be encoded."))), "image/jpeg", quality);
    const blob = await promise;
    if (blob.type !== "image/jpeg") invalid("This browser cannot encode JPEG images.");
    if (blob.size <= IMAGE_BYTES) return blob;
    if (quality > 0.5) {
      quality = Math.max(0.5, quality - 0.15);
      continue;
    }
    if (canvas.width === 1 && canvas.height === 1) invalid("The image cannot be reduced to the size limit.");
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(1, Math.floor(canvas.width * 0.75));
    smaller.height = Math.max(1, Math.floor(canvas.height * 0.75));
    const context = smaller.getContext("2d");
    if (!context) invalid("This browser cannot render images.");
    context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    canvas.width = smaller.width;
    canvas.height = smaller.height;
    canvas.getContext("2d")!.drawImage(smaller, 0, 0);
    smaller.width = smaller.height = 0;
    quality = 0.85;
  }
}

export async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(""));
}

export function fromBase64(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** draws on white, fitted to IMAGE_SIDE; SVG goes through an image element, where its scripts never run */
async function drawImage(canvas: HTMLCanvasElement, blob: Blob, mimeType: string): Promise<void> {
  const paint = (source: CanvasImageSource, width: number, height: number) => {
    const size = fit(width, height);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) invalid("This browser cannot render images.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  };
  if (mimeType === "image/svg+xml") {
    const url = URL.createObjectURL(new Blob([blob], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode().catch(() => invalid("The browser cannot draw this SVG image."));
      paint(image, image.naturalWidth || IMAGE_SIDE, image.naturalHeight || IMAGE_SIDE);
    } finally {
      URL.revokeObjectURL(url);
    }
    return;
  }
  const bitmap = await imageBitmap(blob, mimeType);
  try {
    paint(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

export async function normaliseImage(blob: Blob, mimeType: string): Promise<ImageContent> {
  checkSize(blob);
  const canvas = document.createElement("canvas");
  try {
    await drawImage(canvas, blob, mimeType);
    return { mimeType: "image/jpeg", data: await base64(await jpeg(canvas)) };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export async function attachmentImage(record: AttachmentRecord, page = 1): Promise<ImageContent> {
  checkSize(record.blob);
  if (record.kind === "image") {
    if (page !== 1) throw new RangeError("Images have only page 1.");
    return normaliseImage(record.blob, record.mimeType);
  }
  if (record.kind !== "pdf") invalid("This attachment has no image.");
  const canvas = document.createElement("canvas");
  try {
    await withPdf(record.blob, async (pdf) => {
      if (page > pdf.numPages) throw new RangeError(`page must be between 1 and ${pdf.numPages}.`);
      const pdfPage = await pdf.getPage(page);
      try {
        const initial = pdfPage.getViewport({ scale: 1 });
        if (!Number.isFinite(initial.width) || !Number.isFinite(initial.height) || initial.width <= 0 || initial.height <= 0) invalid("The PDF page has invalid dimensions.");
        const viewport = pdfPage.getViewport({ scale: Math.min(2, IMAGE_SIDE / Math.max(initial.width, initial.height)) });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        await pdfPage.render({ canvas, viewport, background: "rgb(255,255,255)", annotationMode: 0 }).promise;
      } finally {
        pdfPage.cleanup();
      }
    });
    return { mimeType: "image/jpeg", data: await base64(await jpeg(canvas)) };
  } finally {
    canvas.width = canvas.height = 0;
  }
}
