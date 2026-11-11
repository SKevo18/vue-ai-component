import type { Kernel, KernelExecution, KernelRequest, RunOptions, RunResult } from "./types";
/** A time limit that can pause while the program waits for input. */
export declare class RunClock {
    private timer;
    private left;
    private since;
    private readonly onExpire;
    constructor(onExpire: () => void);
    start(ms: number): void;
    pause(): void;
    resume(): void;
    stop(): void;
}
/** Delivers requests itself instead of postMessage (a worker that blocks while idle). */
export interface KernelTransport {
    send(worker: Worker, request: KernelRequest<KernelExecution>): void | Promise<void>;
    dispose?(): void;
}
/** Interactive standard input: a worker blocks for a line the page hands over through this channel. */
export interface StdinChannel {
    /** an id for one run's lines, or null when the channel is not available now */
    open(): Promise<string | null>;
    /** hands line `seq` (null: end of input) of run `run` to the waiting worker */
    send(run: string, seq: number, line: string | null): void;
}
export interface WorkerKernelOptions<E extends KernelExecution, O extends RunOptions> {
    transport?: KernelTransport;
    /** the host's own fields of each run besides stdin, stdinRun and packages */
    execution?(options: O): Omit<E, keyof KernelExecution>;
    stdin?: StdinChannel;
    /** how long the runtime may take to load before the run counts as failed, default 180 s */
    loadLimitMs?: number;
}
export declare function createWorkerKernel<R extends RunResult = RunResult, O extends RunOptions = RunOptions, E extends KernelExecution = KernelExecution>(makeWorker: () => Worker, config?: WorkerKernelOptions<E, O>): Kernel<R, O>;
