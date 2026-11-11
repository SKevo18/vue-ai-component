import type { Approval } from "../core/entries";
import type { HarnessTool } from "../core/tools";
import type { JsonSchema } from "../core/types";
import type { Kernel } from "./types";
import { type CodeLanguage, type MountedFile } from "./workspace";
/** Files the host copies into the workspace, chosen by its own run_code arguments (e.g. site files by address). */
export interface CodeMounts {
    /** extra run_code argument schemas, e.g. `{ uploads: { type: "array", items: { type: "string" } } }` */
    parameters: Record<string, JsonSchema>;
    /** a sentence for the tool description saying where the files land */
    description?: string;
    /** the files to mount for this call; `notes` reach the model (a file that could not be found) */
    files(args: Record<string, unknown>, signal: AbortSignal): Promise<{
        files: MountedFile[];
        notes: string[];
    }>;
}
export interface CodeToolOptions {
    /** URL of the folder serving dist/code-workers/ (javascript-worker.js, python-worker.js), e.g. "/assets/code/" */
    assetsUrl?: string;
    /** URL of the self-hosted Pyodide folder (pyodide.mjs, pyodide-lock.json, packages), e.g. "/assets/pyodide/" */
    pyodideUrl?: string;
    /** default: python when Pyodide (or `kernel`) is there, and javascript */
    languages?: CodeLanguage[];
    /** the host's own kernels (its own workers, policies and time limits) instead of the bundled workers */
    kernel?(language: CodeLanguage): Kernel;
    /** time limit of one run, default 120 s */
    timeLimitMs?: number;
    /** a refusal message for Python packages the host does not allow, or null */
    packagePolicy?(packages: string[]): string | null;
    mounts?: CodeMounts;
    /** extra guidance appended to the tool description */
    description?: string;
    /** default "auto": the code runs sandboxed in this tab and the user sees it */
    approval?: Approval;
}
/** A result object as one JSON line followed by its multi-line text fields as `--- field ---` sections. */
export declare function serializeResult(value: Record<string, unknown>): string;
export declare function createCodeTool(options: CodeToolOptions): HarnessTool;
