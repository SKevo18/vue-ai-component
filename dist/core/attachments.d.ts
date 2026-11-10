import type { AttachmentRecord } from "./attachment-store";
import type { ImageContent } from "./types";
export declare const MAX_ATTACHMENT_BYTES: number;
export declare const PASTE_ATTACHMENT_THRESHOLD = 12000;
export type AttachmentErrorCode = "tooLarge" | "unsupported" | "invalid" | "pdfUnavailable";
export declare class AttachmentError extends Error {
    readonly code: AttachmentErrorCode;
    constructor(code: AttachmentErrorCode, message: string);
}
/** pdfjs data files (`cmaps/`, `standard_fonts/`, `wasm/`) live below assetsUrl */
export interface PdfOptions {
    workerSrc: string | URL;
    assetsUrl?: string | URL;
}
export declare function configurePdf(options: PdfOptions | null): void;
export declare function textOf(blob: Blob): Promise<string>;
export declare function rasterMime(bytes: Uint8Array): string | null;
/** applies the JPEG orientation and refuses oversized images before decoding */
export declare function rasterSize(bytes: Uint8Array, mime: string): {
    width: number;
    height: number;
};
export declare function inspectAttachment(file: File): Promise<Pick<AttachmentRecord, "name" | "mimeType" | "size" | "kind" | "blob">>;
export declare function renderNotebook(name: string, notebook: unknown): string | null;
export declare function attachmentContent(record: AttachmentRecord, uri: string, page?: number): Promise<{
    name: string;
    mimeType: string;
    text?: string;
    image?: {
        uri: string;
        page?: number;
    };
    page?: number;
    pages?: number;
}>;
export declare function base64(blob: Blob): Promise<string>;
export declare function fromBase64(data: string, mimeType: string): Blob;
export declare function normaliseImage(blob: Blob, mimeType: string): Promise<ImageContent>;
export declare function attachmentImage(record: AttachmentRecord, page?: number): Promise<ImageContent>;
