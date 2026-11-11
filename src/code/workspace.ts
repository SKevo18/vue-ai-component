// The run_code workspace of one conversation: one retained kernel per language. Chat attachments are mounted under
// attachments/, host files (CodeMounts) where the host says. Figures and the image files named in `show` come back as
// images.
import type { Kernel } from "./types";

export const CODE_LANGUAGES = ["python", "javascript"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** characters of stdout, stderr or error per run: the start and the end of longer output */
export const OUTPUT_CHARS = 12000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_LISTED_FILES = 200;

/** A file to write into the workspace before a run. */
export interface MountedFile {
  /** workspace path, e.g. `uploads/2026/data.csv` */
  path: string;
  /** what the content is, e.g. its address; an unchanged source is not written again */
  source: string;
  blob(): Promise<Blob>;
}

export interface WorkspaceRequest {
  language: CodeLanguage;
  code: string;
  packages?: string[];
  /** workspace paths of image files to return as images */
  show?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface WorkspaceAttachment {
  /** stable source id, e.g. the attachment URI */
  id: string;
  name: string;
  blob: Blob;
}

export interface WorkspaceImage {
  name: string;
  mimeType: string;
  /** base64 */
  data: string;
}

export interface WorkspaceResult {
  language: CodeLanguage;
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  duration_ms: number;
  files: { name: string; size: number }[];
  files_total?: number;
  notes?: string[];
}

interface Slot {
  kernel: Kernel;
  /** workspace path -> source of what was written there; attachments are `attachment:<id>` */
  mounted: Map<string, string>;
}

/**
 * Workspace paths of attachments: attachments/<name> with the name reduced to letters, digits, dot, dash and
 * underscore; repeated names get -2, -3 before the extension.
 */
export function attachmentPaths(files: { id: string; name: string }[]): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const file of files) {
    const clean =
      file.name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(-80) || "file";
    const dot = clean.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    let path = `attachments/${clean}`;
    for (let n = 2; taken.has(path); n++) path = `attachments/${stem}-${n}${ext}`;
    taken.add(path);
    out.set(file.id, path);
  }
  return out;
}

/** Long output keeps its start and end around a marker naming the omitted length. */
export function clipOutput(text: string, limit = OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = Math.floor((limit * 2) / 3);
  const tail = limit - head;
  return `${text.slice(0, head)}\n[... ${text.length - limit} characters omitted; print less ...]\n${text.slice(-tail)}`;
}

function rasterMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** SVG drawn on white as PNG: models take raster images only. Scripts in the SVG never run in an image element. */
async function svgToPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([blob], { type: "image/svg+xml" }));
  const canvas = document.createElement("canvas");
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new Error("The browser cannot draw this SVG image.");
    });
    const scale = Math.min(1, 1536 / Math.max(image.naturalWidth || 1536, image.naturalHeight || 1536));
    canvas.width = Math.max(1, Math.round((image.naturalWidth || 1536) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || 1536) * scale));
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const done = Promise.withResolvers<Blob>();
    canvas.toBlob((b) => (b ? done.resolve(b) : done.reject(new Error("The SVG image could not be converted."))), "image/png");
    return await done.promise;
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}

/** The image as base64 with its type, or a reason it is not one. */
async function toImage(name: string, blob: Blob): Promise<WorkspaceImage | string> {
  const mime = rasterMime(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
  if (mime) return { name, mimeType: mime, data: await base64(blob) };
  if (blob.type === "image/svg+xml" || /\.svg$/i.test(name)) return { name, mimeType: "image/png", data: await base64(await svgToPng(blob)) };
  return `show: ${name} is not a PNG, JPEG, GIF, WebP or SVG image.`;
}

export class CodeWorkspace {
  private readonly slots = new Map<CodeLanguage, Slot>();
  private readonly createKernel: (language: CodeLanguage) => Kernel;

  constructor(createKernel: (language: CodeLanguage) => Kernel) {
    this.createKernel = createKernel;
  }

  /** Ends every kernel; the next run starts fresh. */
  dispose(): void {
    for (const slot of this.slots.values()) slot.kernel.dispose();
    this.slots.clear();
  }

  private slot(language: CodeLanguage): Slot {
    let slot = this.slots.get(language);
    if (!slot) {
      slot = { kernel: this.createKernel(language), mounted: new Map() };
      this.slots.set(language, slot);
    }
    return slot;
  }

  /** Writes attachments and host files that are missing or changed, removes attachments no longer attached. */
  private async mount(slot: Slot, attachments: WorkspaceAttachment[], extra: MountedFile[], notes: string[]): Promise<void> {
    const wanted = new Map<string, WorkspaceAttachment>();
    for (const [id, path] of attachmentPaths(attachments)) wanted.set(path, attachments.find((f) => f.id === id)!);
    for (const [path, source] of slot.mounted) {
      if (source.startsWith("attachment:") && `attachment:${wanted.get(path)?.id}` !== source) {
        await slot.kernel.removeFile(path).catch(() => undefined);
        slot.mounted.delete(path);
      }
    }
    for (const [path, file] of wanted) {
      if (slot.mounted.get(path) === `attachment:${file.id}`) continue;
      try {
        await slot.kernel.writeFile(path, new Uint8Array(await file.blob.arrayBuffer()));
        slot.mounted.set(path, `attachment:${file.id}`);
      } catch (e) {
        notes.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const file of extra) {
      if (slot.mounted.get(file.path) === file.source) continue;
      try {
        const blob = await file.blob();
        if (blob.size > MAX_FILE_BYTES) throw new Error(`${file.source} is larger than 20 MiB.`);
        await slot.kernel.writeFile(file.path, new Uint8Array(await blob.arrayBuffer()));
        slot.mounted.set(file.path, file.source);
      } catch (e) {
        notes.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async run(request: WorkspaceRequest, attachments: WorkspaceAttachment[] = [], mounts: { files: MountedFile[]; notes: string[] } = { files: [], notes: [] }): Promise<{ result: WorkspaceResult; images: WorkspaceImage[] }> {
    const { language } = request;
    const notes = [...mounts.notes];
    const slot = this.slot(language);
    await this.mount(slot, attachments, mounts.files, notes);
    const result = await slot.kernel.execute(request.code, { timeoutMs: request.timeoutMs, packages: language === "python" ? request.packages : undefined, signal: request.signal });
    const blobs: { name: string; blob: Blob }[] = (result.figures ?? []).map((data, i) => ({
      name: `figure-${i + 1}.png`,
      blob: new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "image/png" }),
    }));
    let files: { name: string; size: number }[] = [];
    if (slot.kernel.lost) {
      slot.kernel.dispose();
      this.slots.delete(language);
      notes.push("The workspace was reset (time limit, stop or crash): variables and written files are gone; attachments are mounted again on the next run.");
    } else {
      files = await slot.kernel.listFiles();
      for (const path of request.show ?? []) {
        const file = files.find((f) => f.name === path);
        if (!file) notes.push(`show: no file ${path} in the workspace.`);
        else if (file.size > MAX_FILE_BYTES) notes.push(`show: ${path} is larger than 20 MiB.`);
        else blobs.push({ name: path.split("/").pop()!, blob: new Blob([(await slot.kernel.readFile(path)).slice()]) });
      }
    }
    const images: WorkspaceImage[] = [];
    for (const { name, blob } of blobs) {
      if (images.length >= MAX_IMAGES) {
        notes.push(`Only the first ${MAX_IMAGES} images of a run are shown.`);
        break;
      }
      try {
        const image = await toImage(name, blob);
        if (typeof image === "string") notes.push(image);
        else images.push(image);
      } catch (e) {
        notes.push(`show: ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return {
      result: {
        language,
        ok: !result.error,
        stdout: clipOutput(result.stdout),
        stderr: clipOutput(result.stderr),
        ...(result.error && { error: clipOutput(result.error) }),
        duration_ms: result.duration_ms,
        files: files.slice(0, MAX_LISTED_FILES).map(({ name, size }) => ({ name, size })),
        ...(files.length > MAX_LISTED_FILES && { files_total: files.length }),
        ...(notes.length && { notes }),
      },
      images,
    };
  }
}
