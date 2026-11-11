import type { KernelEngine, KernelExecution, RunResult } from "../types";
import { type InputFactory } from "./input";
import { JavaScriptFiles } from "./javascript-fs";
export declare function errorText(error: unknown): string;
export interface JavaScriptRun {
    files: JavaScriptFiles;
    stdout: string;
    stderr: string;
    error?: string;
}
export interface JavaScriptEngineOptions<E extends KernelExecution, R extends RunResult> {
    /** interactive input; the default reads the run's pre-filled stdin */
    input?: InputFactory<E>;
    /** extra result fields after a run, such as test outcomes */
    finish?(options: E, run: JavaScriptRun): Promise<Partial<R>> | Partial<R>;
}
/** Installs the kernel's globals on this worker and returns its engine; call it once per worker. */
export declare function createJavaScriptEngine<E extends KernelExecution = KernelExecution, R extends RunResult = RunResult>(hooks?: JavaScriptEngineOptions<E, R>): KernelEngine<E, R>;
