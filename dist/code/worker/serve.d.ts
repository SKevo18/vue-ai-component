import type { KernelEngine, KernelExecution, KernelRequest, RunResult } from "../types";
/**
 * Answers the kernel client's requests one at a time. The engine and its file system stay alive between requests;
 * only per-command I/O is replaced. `create` gets the first request, with any fields the host's transport added.
 */
export declare function serveKernel<E extends KernelExecution = KernelExecution, R extends RunResult = RunResult>(create: (initial: KernelRequest<E> & Record<string, unknown>) => KernelEngine<E, R> | Promise<KernelEngine<E, R>>): void;
