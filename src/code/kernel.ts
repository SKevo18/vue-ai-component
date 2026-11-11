// The page side of a retained interpreter in a web worker: a queue of requests, the load and run time limits, stop,
// and interactive input through a host channel.
import { clip, clipInputs, KERNEL_LOST, RUN_STOPPED, timeLimitError } from "./types";
import type { Kernel, KernelExecution, KernelFile, KernelRequest, KernelResponse, KernelValue, RunOptions, RunResult } from "./types";

const LOAD_LIMIT_MS = 180_000;

/** A time limit that can pause while the program waits for input. */
export class RunClock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private left = 0;
  private since = 0;
  private readonly onExpire: () => void;

  constructor(onExpire: () => void) {
    this.onExpire = onExpire;
  }

  start(ms: number): void {
    this.stop();
    this.left = ms;
    this.resume();
  }

  pause(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.left = Math.max(0, this.left - (performance.now() - this.since));
  }

  resume(): void {
    if (this.timer !== undefined) return;
    this.since = performance.now();
    this.timer = setTimeout(this.onExpire, this.left);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
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

interface Pending<R extends RunResult> {
  id: number;
  receive(message: KernelResponse<R>): void;
  fail(error: string): void;
}

export function createWorkerKernel<R extends RunResult = RunResult, O extends RunOptions = RunOptions, E extends KernelExecution = KernelExecution>(
  makeWorker: () => Worker,
  config: WorkerKernelOptions<E, O> = {},
): Kernel<R, O> {
  const { transport, stdin } = config;
  let worker: Worker | undefined;
  let lost = false;
  let sequence = 0;
  let pending: Pending<R> | undefined;
  let queue = Promise.resolve();

  function destroy(error: string): void {
    if (lost) return;
    lost = true;
    worker?.terminate();
    worker = undefined;
    try {
      transport?.dispose?.();
    } finally {
      pending?.fail(error);
    }
  }

  function enqueue<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = Promise.withResolvers<T>();
    let started = false;
    const abort = () => {
      if (!started) result.reject(new Error(RUN_STOPPED));
    };
    signal?.addEventListener("abort", abort, { once: true });
    queue = queue.then(async () => {
      started = true;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return result.reject(new Error(RUN_STOPPED));
      if (lost) return result.reject(new Error(KERNEL_LOST));
      try {
        result.resolve(await action());
      } catch (error) {
        result.reject(error);
      }
    });
    if (signal?.aborted) abort();
    return result.promise;
  }

  function request<T extends KernelValue<R>>(build: (id: number) => KernelRequest<E> | Promise<KernelRequest<E>>, opts?: O): Promise<T> {
    const result = Promise.withResolvers<T>();
    const id = ++sequence;
    let done = false;
    let running = false;
    let stdinRun: string | null = null;
    let inputSequence = 0;
    const clock = new RunClock(() => destroy(timeLimitError(opts!.timeoutMs)));
    let loadTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => destroy("The runtime did not load in time"), config.loadLimitMs ?? LOAD_LIMIT_MS);
    const abort = () => destroy(RUN_STOPPED);
    const finish = (value: T | undefined, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(loadTimer);
      clock.stop();
      opts?.signal?.removeEventListener("abort", abort);
      if (pending?.id === id) pending = undefined;
      if (error !== undefined) result.reject(new Error(error));
      else result.resolve(value as T);
    };
    pending = {
      id,
      fail: (error) => finish(undefined, error),
      receive(message) {
        if (message.type === "lost") return destroy(message.error);
        if (done || message.id !== id) return;
        if (message.type === "result") finish(message.value as T);
        else if (message.type === "error") {
          if (!message.fatal) return finish(undefined, message.error);
          if (message.result) finish({ ...message.result, error: message.error } as T);
          destroy(message.error);
        } else if (message.type === "status") {
          if (message.status === "running" && opts && !running) {
            running = true;
            clearTimeout(loadTimer);
            loadTimer = undefined;
            clock.start(opts.timeoutMs);
          }
          opts?.onStatus?.(message.status);
        } else if (message.type === "input" && stdinRun && stdin && opts?.onInput && message.seq > inputSequence) {
          inputSequence = message.seq;
          clock.pause();
          const run = stdinRun;
          void (async () => {
            let line: string | null = null;
            try {
              line = await opts.onInput!({ stdout: message.stdout, stderr: message.stderr, inputs: message.inputs });
            } catch {
              // a dismissed input request is end of input
            }
            if (done || lost || pending?.id !== id || inputSequence !== message.seq) return;
            stdin.send(run, message.seq, line);
            clock.resume();
          })();
        }
      },
    };
    opts?.signal?.addEventListener("abort", abort, { once: true });
    if (opts?.signal?.aborted) abort();
    if (!done)
      void (async () => {
        try {
          opts?.onStatus?.("loading");
          if (!worker) {
            worker = makeWorker();
            worker.onmessage = (event: MessageEvent<KernelResponse<R>>) => {
              if (event.data?.type === "lost") destroy(event.data.error);
              else if (!lost && event.data?.id === pending?.id) pending?.receive(event.data);
            };
            worker.onerror = (event) => {
              event.preventDefault();
              destroy(event.message || "The kernel worker failed");
            };
            worker.onmessageerror = () => destroy("The kernel response could not be read");
          }
          const message = await build(id);
          if (done || lost) return;
          if (message.op === "execute") stdinRun = message.options.stdinRun;
          if (transport) await transport.send(worker, message);
          else worker.postMessage(message);
        } catch (error) {
          if (!done) destroy(error instanceof Error ? error.message : String(error));
        }
      })();
    return result.promise;
  }

  return {
    get lost() {
      return lost;
    },
    async execute(source, opts) {
      const started = performance.now();
      try {
        const value = await enqueue(
          () =>
            request<R>(async (id) => {
              const stdinRun = opts.onInput && stdin ? await stdin.open() : null;
              const options = { ...config.execution?.(opts), stdin: opts.stdin ?? "", stdinRun, packages: opts.packages ?? [] } as E;
              return { id, op: "execute", source, options };
            }, opts),
          opts.signal,
        );
        return { ...value, stdout: clip(value.stdout), stderr: clip(value.stderr), inputs: clipInputs(value.inputs), inputUnavailable: !!opts.onInput && !!value.inputUnavailable, duration_ms: Math.round(performance.now() - started) };
      } catch (error) {
        return { stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error), exitCode: 1, duration_ms: Math.round(performance.now() - started) } as R;
      }
    },
    listFiles: () => enqueue(() => request<KernelFile[]>((id) => ({ id, op: "listFiles" }))),
    readFile: (name) => enqueue(() => request<Uint8Array>((id) => ({ id, op: "readFile", name }))),
    writeFile(name, data) {
      const bytes = data.slice();
      return enqueue(() => request<void>((id) => ({ id, op: "writeFile", name, data: bytes })));
    },
    removeFile: (name) => enqueue(() => request<void>((id) => ({ id, op: "removeFile", name }))),
    dispose: () => destroy(KERNEL_LOST),
  };
}
