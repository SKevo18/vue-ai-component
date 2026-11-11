import type { Kernel } from "./types";
export declare const CODE_LANGUAGES: readonly ["python", "javascript"];
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
/** characters of stdout, stderr or error per run: the start and the end of longer output */
export declare const OUTPUT_CHARS = 12000;
export declare const MAX_FILE_BYTES: number;
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
    files: {
        name: string;
        size: number;
    }[];
    files_total?: number;
    notes?: string[];
}
/**
 * Workspace paths of attachments: attachments/<name> with the name reduced to letters, digits, dot, dash and
 * underscore; repeated names get -2, -3 before the extension.
 */
export declare function attachmentPaths(files: {
    id: string;
    name: string;
}[]): Map<string, string>;
/** Long output keeps its start and end around a marker naming the omitted length. */
export declare function clipOutput(text: string, limit?: number): string;
export declare class CodeWorkspace {
    private readonly slots;
    private readonly createKernel;
    constructor(createKernel: (language: CodeLanguage) => Kernel);
    /** Ends every kernel; the next run starts fresh. */
    dispose(): void;
    private slot;
    /** Writes attachments and host files that are missing or changed, removes attachments no longer attached. */
    private mount;
    run(request: WorkspaceRequest, attachments?: WorkspaceAttachment[], mounts?: {
        files: MountedFile[];
        notes: string[];
    }): Promise<{
        result: WorkspaceResult;
        images: WorkspaceImage[];
    }>;
}
