export type RunStatus = "compiling" | "loading" | "running";
/** A line of standard input the program read; `at` is the length of its stdout at that moment. */
export interface InputLine {
    at: number;
    text: string;
}
/** Sent with each request for a line: the output written since the previous request and every line read so far. */
export interface InputRequest {
    stdout: string;
    stderr: string;
    inputs: InputLine[];
}
export interface KernelFile {
    name: string;
    size: number;
}
export interface RunResult {
    stdout: string;
    stderr: string;
    /** user-facing failure of the program (exception, time limit, missing runtime) */
    error?: string;
    exitCode?: number;
    duration_ms: number;
    /** PNG images (base64) of the matplotlib figures the program produced */
    figures?: string[];
    /** the program asked for more input than `stdin` held and interactive input was not available */
    inputUnavailable?: boolean;
    /** input lines the program read, at their positions in `stdout` */
    inputs?: InputLine[];
}
export interface RunOptions {
    timeoutMs: number;
    onStatus?: (status: RunStatus) => void;
    /** Python packages to load before the program */
    packages?: string[];
    /** standard input given up front, read one line per read */
    stdin?: string;
    /** interactive standard input once `stdin` is used up; needs a `StdinChannel` on the kernel */
    onInput?: (request: InputRequest) => Promise<string | null>;
    /** stops the program (the worker is terminated); the result's error is RUN_STOPPED */
    signal?: AbortSignal;
}
/** A retained interpreter. A lost kernel must be disposed and recreated, never replayed. */
export interface Kernel<R extends RunResult = RunResult, O extends RunOptions = RunOptions> {
    readonly lost: boolean;
    execute(source: string, options: O): Promise<R>;
    listFiles(): Promise<KernelFile[]>;
    readFile(name: string): Promise<Uint8Array>;
    writeFile(name: string, data: Uint8Array): Promise<void>;
    removeFile(name: string): Promise<void>;
    dispose(): void;
}
/** `RunResult.error` of a run stopped through `RunOptions.signal` */
export declare const RUN_STOPPED = "Stopped";
export declare const KERNEL_LOST = "The kernel state was lost. Reset the kernel to continue.";
/** characters of stdout or stderr kept per run */
export declare const OUTPUT_LIMIT: number;
export declare function clip(text: string): string;
/** the input lines read within the part of stdout that clip() keeps; undefined when there are none */
export declare function clipInputs(inputs: InputLine[] | undefined): InputLine[] | undefined;
export declare function timeLimitError(ms: number): string;
/** What a worker gets with each run; hosts extend it with their own fields (KernelOptions.execution). */
export interface KernelExecution {
    stdin: string;
    /** id of the interactive input channel, null when the run has none */
    stdinRun: string | null;
    packages: string[];
}
/** Input request a worker posts before it blocks for line `seq`. */
export interface InputMessage extends InputRequest {
    type: "input";
    seq: number;
}
export type KernelRequest<E extends KernelExecution = KernelExecution> = {
    id: number;
    op: "execute";
    source: string;
    options: E;
} | {
    id: number;
    op: "listFiles";
} | {
    id: number;
    op: "readFile" | "removeFile";
    name: string;
} | {
    id: number;
    op: "writeFile";
    name: string;
    data: Uint8Array;
};
export type KernelValue<R extends RunResult = RunResult> = R | KernelFile[] | Uint8Array | void;
export type KernelResponse<R extends RunResult = RunResult> = {
    id: number;
    type: "result";
    value: KernelValue<R>;
} | {
    id: number;
    type: "error";
    error: string;
    fatal?: boolean;
    result?: R;
} | {
    id: number;
    type: "status";
    status: RunStatus;
} | {
    type: "lost";
    error: string;
} | ({
    id: number;
} & InputMessage);
export interface KernelIO {
    status(status: RunStatus): void;
    input(message: InputMessage): void;
}
type Awaitable<T> = T | Promise<T>;
export interface KernelEngine<E extends KernelExecution = KernelExecution, R extends RunResult = RunResult> {
    execute(source: string, options: E, io: KernelIO): Awaitable<R>;
    listFiles(): Awaitable<KernelFile[]>;
    readFile(name: string): Awaitable<Uint8Array>;
    writeFile(name: string, data: Uint8Array): Awaitable<void>;
    removeFile(name: string): Awaitable<void>;
}
export {};
