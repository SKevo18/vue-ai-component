import type { InputLine, KernelExecution, KernelIO } from "../types";
/** Standard input of one run inside a worker. */
export interface InputSource {
    /** the next line without its line break, null at end of input */
    readLine(): string | null;
    /** every line read so far, at the length stdout had then */
    readonly inputs: InputLine[];
    /** the program wanted more input than there was and no interactive channel answered */
    readonly unavailable: boolean;
}
/** The program's output captured so far. */
export type OutputSoFar = () => {
    stdout: string;
    stderr: string;
};
/** Builds a run's input: hosts with an interactive channel pass their own, the default reads `options.stdin` only. */
export type InputFactory<E extends KernelExecution = KernelExecution> = (options: E, output: OutputSoFar, io: KernelIO) => InputSource;
/** The pre-filled input of a run, one line per read, then end of input. */
export declare function prefilledInput(text: string, output: OutputSoFar): InputSource;
