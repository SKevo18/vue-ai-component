// The JavaScript kernel inside a classic worker: console capture, global scripts that keep their declarations
// between runs, timers that finish within their run, prompt() from standard input, and an in-memory file system
// behind the globals fs, require, module and exports.
import type { KernelEngine, KernelExecution, RunResult } from "../types";
import { runGlobalScript } from "./classic-script";
import { prefilledInput, type InputFactory } from "./input";
import { JavaScriptFiles } from "./javascript-fs";

const LIMIT = 64 * 1024;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.stack || String(error) : String(error);
}

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
export function createJavaScriptEngine<E extends KernelExecution = KernelExecution, R extends RunResult = RunResult>(hooks: JavaScriptEngineOptions<E, R> = {}): KernelEngine<E, R> {
  const out = { stdout: "", stderr: "" };
  let error: string | undefined;
  let active = false;
  const files = new JavaScriptFiles();
  files.installCommonJS(self);

  function write(stream: "stdout" | "stderr", args: unknown[]): void {
    if (!active || out[stream].length > LIMIT) return;
    const line = args
      .map((value) => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return value.stack || String(value);
        if (["function", "symbol", "bigint"].includes(typeof value)) return String(value);
        try {
          return JSON.stringify(value) ?? String(value);
        } catch {
          return String(value);
        }
      })
      .join(" ");
    out[stream] += line + "\n";
  }
  self.console.log = self.console.info = self.console.debug = (...args: unknown[]) => write("stdout", args);
  self.console.warn = self.console.error = (...args: unknown[]) => write("stderr", args);
  self.addEventListener("error", (event) => {
    if (active) error ??= event.error ? errorText(event.error) : event.message;
    event.preventDefault();
  });
  self.addEventListener("unhandledrejection", (event) => {
    if (active) error ??= errorText(event.reason);
    event.preventDefault();
  });

  const pending = new Set<number>();
  const nativeSetTimeout = self.setTimeout.bind(self);
  const nativeClearTimeout = self.clearTimeout.bind(self);
  const nativeSetInterval = self.setInterval.bind(self);
  const nativeClearInterval = self.clearInterval.bind(self);
  Object.assign(self, {
    setTimeout(handler: TimerHandler, ms?: number, ...args: unknown[]) {
      const id = nativeSetTimeout(() => {
        pending.delete(id);
        if (typeof handler === "function") handler(...args);
        else runGlobalScript(handler);
      }, ms);
      pending.add(id);
      return id;
    },
    clearTimeout(id?: number) {
      if (id !== undefined) pending.delete(id);
      nativeClearTimeout(id);
    },
    setInterval(handler: TimerHandler, ms?: number, ...args: unknown[]) {
      const id = nativeSetInterval(() => {
        if (typeof handler === "function") handler(...args);
        else runGlobalScript(handler);
      }, ms);
      pending.add(id);
      return id;
    },
    clearInterval(id?: number) {
      if (id !== undefined) pending.delete(id);
      nativeClearInterval(id);
    },
  });

  return {
    async execute(source, options, io) {
      out.stdout = "";
      out.stderr = "";
      error = undefined;
      active = true;
      const output = () => out;
      const stdin = hooks.input ? hooks.input(options, output, io) : prefilledInput(options.stdin, output);
      Object.assign(self, {
        prompt(message?: unknown) {
          if (message !== undefined && out.stdout.length <= LIMIT) out.stdout += String(message);
          return stdin.readLine();
        },
      });
      io.status("running");
      try {
        runGlobalScript(source);
      } catch (cause) {
        error ??= errorText(cause);
      }
      // user timers and their queued microtasks belong to this run, also after a synchronous exception
      do {
        const settled = Promise.withResolvers<void>();
        nativeSetTimeout(settled.resolve, pending.size ? 10 : 0);
        await settled.promise;
      } while (pending.size);
      const extra = (await hooks.finish?.(options, { files, stdout: out.stdout, stderr: out.stderr, error })) ?? {};
      active = false;
      return { stdout: out.stdout, stderr: out.stderr, error, exitCode: error === undefined ? 0 : 1, duration_ms: 0, inputUnavailable: stdin.unavailable, inputs: stdin.inputs, ...extra } as R;
    },
    listFiles: () => files.listFiles(),
    readFile: (name) => files.readFile(name),
    writeFile: (name, data) => files.writeFile(name, data),
    removeFile: (name) => files.removeFile(name),
  };
}
