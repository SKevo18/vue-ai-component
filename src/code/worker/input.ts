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
export type OutputSoFar = () => { stdout: string; stderr: string };

/** Builds a run's input: hosts with an interactive channel pass their own, the default reads `options.stdin` only. */
export type InputFactory<E extends KernelExecution = KernelExecution> = (options: E, output: OutputSoFar, io: KernelIO) => InputSource;

/** The pre-filled input of a run, one line per read, then end of input. */
export function prefilledInput(text: string, output: OutputSoFar): InputSource {
  let pos = 0;
  const source = {
    inputs: [] as InputLine[],
    unavailable: false,
    readLine(): string | null {
      if (pos >= text.length) {
        source.unavailable = true;
        return null;
      }
      const newline = text.indexOf("\n", pos);
      const end = newline < 0 ? text.length : newline;
      const line = text.slice(pos, end).replace(/\r$/, "");
      pos = end + 1;
      source.inputs.push({ at: output().stdout.length, text: line });
      return line;
    },
  };
  return source;
}
