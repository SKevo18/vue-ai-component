import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerKernel, type StdinChannel } from "./kernel";
import { KERNEL_LOST, type KernelRequest, type KernelResponse } from "./types";

const stdin: StdinChannel = { open: async () => "stdin-zorp", send: vi.fn() };

class TestWorker {
  onmessage: ((event: MessageEvent<KernelResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  private readonly requests: KernelRequest[] = [];
  private waiting: PromiseWithResolvers<KernelRequest> | undefined;
  postMessage(request: KernelRequest): void {
    if (this.waiting) {
      this.waiting.resolve(request);
      this.waiting = undefined;
    } else this.requests.push(request);
  }
  next(): Promise<KernelRequest> {
    const ready = this.requests.shift();
    if (ready) return Promise.resolve(ready);
    this.waiting = Promise.withResolvers<KernelRequest>();
    return this.waiting.promise;
  }
  emit(message: KernelResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<KernelResponse>);
  }
}

const value = { stdout: "zorp\n", stderr: "", duration_ms: 0 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("retained kernel transport", () => {
  it("serializes execution and binary file commands without reinitializing the worker", async () => {
    const worker = new TestWorker();
    const make = vi.fn(() => worker as unknown as Worker);
    const kernel = createWorkerKernel(make);
    const execution = kernel.execute("let zorp = 9", { timeoutMs: 100 });
    const first = await worker.next();
    const bytes = new Uint8Array([0, 255]);
    const writing = kernel.writeFile("odd.bin", bytes);
    bytes.fill(4);
    worker.emit({ type: "result", id: first.id, value });
    expect((await execution).stdout).toBe("zorp\n");
    const write = await worker.next();
    expect(write.op).toBe("writeFile");
    if (write.op !== "writeFile") throw new Error("Expected file write");
    expect([...write.data]).toEqual([0, 255]);
    worker.emit({ type: "result", id: write.id, value: undefined });
    await writing;
    const reading = kernel.readFile("odd.bin");
    const read = await worker.next();
    worker.emit({ type: "result", id: read.id, value: new Uint8Array([0, 255]) });
    expect([...await reading]).toEqual([0, 255]);
    expect(make).toHaveBeenCalledTimes(1);
    expect(kernel.lost).toBe(false);
    kernel.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued cell without killing the current unrelated execution", async () => {
    const worker = new TestWorker();
    const kernel = createWorkerKernel(() => worker as unknown as Worker);
    const active = kernel.execute("slow()", { timeoutMs: 100 });
    const request = await worker.next();
    const controller = new AbortController();
    const queued = kernel.execute("mustNotRun()", { timeoutMs: 100, signal: controller.signal });
    controller.abort();
    expect((await queued).error).toBe("Stopped");
    expect(kernel.lost).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit({ type: "result", id: request.id, value });
    expect((await active).error).toBeUndefined();
    kernel.dispose();
  });

  it("loses state on a hard timeout and never silently starts a replacement", async () => {
    const worker = new TestWorker();
    const make = vi.fn(() => worker as unknown as Worker);
    const kernel = createWorkerKernel(make);
    const execution = kernel.execute("while (true) {}", { timeoutMs: 100 });
    const request = await worker.next();
    worker.emit({ type: "status", id: request.id, status: "running" });
    await vi.advanceTimersByTimeAsync(100);
    expect((await execution).error).toContain("Time limit exceeded");
    expect(kernel.lost).toBe(true);
    expect((await kernel.execute("zorp", { timeoutMs: 100 })).error).toBe(KERNEL_LOST);
    await expect(kernel.listFiles()).rejects.toThrow(KERNEL_LOST);
    expect(make).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("aborts an active cell by destroying its state", async () => {
    const worker = new TestWorker();
    const kernel = createWorkerKernel(() => worker as unknown as Worker);
    const controller = new AbortController();
    const execution = kernel.execute("spin()", { timeoutMs: 100, signal: controller.signal });
    await worker.next();
    controller.abort();
    expect((await execution).error).toBe("Stopped");
    expect(kernel.lost).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(kernel.readFile("before.bin")).rejects.toThrow(KERNEL_LOST);
  });

  it("ignores late responses from an earlier cell", async () => {
    const worker = new TestWorker();
    const kernel = createWorkerKernel(() => worker as unknown as Worker);
    const first = kernel.execute("first", { timeoutMs: 100 });
    const one = await worker.next();
    worker.emit({ type: "result", id: one.id, value });
    await first;
    const second = kernel.execute("second", { timeoutMs: 100 });
    const two = await worker.next();
    worker.emit({ type: "result", id: one.id, value: { ...value, stdout: "wrong" } });
    worker.emit({ type: "result", id: two.id, value: { ...value, stdout: "right" } });
    expect((await second).stdout).toBe("right");
    kernel.dispose();
  });

  it("pauses for stdin and ignores an answer after the kernel is disposed", async () => {
    const worker = new TestWorker();
    const kernel = createWorkerKernel(() => worker as unknown as Worker, { stdin });
    const answer = Promise.withResolvers<string | null>();
    const execution = kernel.execute("prompt()", { timeoutMs: 100, onInput: () => answer.promise });
    const request = await worker.next();
    expect(request.op === "execute" && request.options.stdinRun).toBe("stdin-zorp");
    worker.emit({ type: "status", id: request.id, status: "running" });
    worker.emit({ type: "input", id: request.id, seq: 1, stdout: "", stderr: "", inputs: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(kernel.lost).toBe(false);
    kernel.dispose();
    answer.resolve("too late");
    expect((await execution).error).toBe(KERNEL_LOST);
    expect(stdin.send).not.toHaveBeenCalled();
  });

  it("hands an answered line to the stdin channel and adds the host's run fields", async () => {
    const worker = new TestWorker();
    const kernel = createWorkerKernel<{ stdout: string; stderr: string; duration_ms: number }, { timeoutMs: number; onInput?: () => Promise<string | null>; quux: number }, { stdin: string; stdinRun: string | null; packages: string[]; quux: number }>(
      () => worker as unknown as Worker,
      { stdin, execution: (opts) => ({ quux: opts.quux }) },
    );
    const execution = kernel.execute("prompt()", { timeoutMs: 100, quux: 7, onInput: async () => "plugh" });
    const request = await worker.next();
    expect(request.op === "execute" && request.options).toEqual({ quux: 7, stdin: "", stdinRun: "stdin-zorp", packages: [] });
    worker.emit({ type: "status", id: request.id, status: "running" });
    worker.emit({ type: "input", id: request.id, seq: 1, stdout: "", stderr: "", inputs: [] });
    await vi.waitFor(() => expect(stdin.send).toHaveBeenCalledWith("stdin-zorp", 1, "plugh"));
    worker.emit({ type: "result", id: request.id, value });
    expect((await execution).stdout).toBe("zorp\n");
  });

  it("reports resident idle loss even with no pending operation", async () => {
    const worker = new TestWorker();
    const kernel = createWorkerKernel(() => worker as unknown as Worker);
    const listing = kernel.listFiles();
    const request = await worker.next();
    worker.emit({ type: "result", id: request.id, value: [] });
    await listing;
    worker.emit({ type: "lost", error: "Resident control channel closed" });
    expect(kernel.lost).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
