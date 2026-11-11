import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "./types";
import { CodeWorkspace, type WorkspaceAttachment, type WorkspaceRequest } from "./workspace";

/** An in-memory kernel whose run is whatever the test sets as `program`. */
class FakeKernel {
  files = new Map<string, Uint8Array>();
  lost = false;
  disposed = false;
  async execute(code: string): Promise<RunResult> {
    return { stdout: "", stderr: "", duration_ms: 1, ...program(this, code) };
  }
  async listFiles() {
    return [...this.files].map(([name, data]) => ({ name, size: data.byteLength }));
  }
  async readFile(name: string) {
    return this.files.get(name)!;
  }
  async writeFile(name: string, data: Uint8Array) {
    this.files.set(name, data);
  }
  async removeFile(name: string) {
    this.files.delete(name);
  }
  dispose() {
    this.disposed = true;
  }
}

let kernels: FakeKernel[] = [];
let program: (kernel: FakeKernel, code: string) => Partial<RunResult> = () => ({});
const workspace = () =>
  new CodeWorkspace(() => {
    const kernel = new FakeKernel();
    kernels.push(kernel);
    return kernel;
  });

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);
const file = (id: string, name: string, body: string): WorkspaceAttachment => ({ id, name, blob: new Blob([body]) });
const request = (over: Partial<WorkspaceRequest>): WorkspaceRequest => ({ language: "python", code: "pass", timeoutMs: 1000, ...over });

beforeEach(() => {
  kernels = [];
  program = () => ({});
});

describe("code workspace", () => {
  it("mounts attached files under attachments/ with safe unique names and removes detached ones", async () => {
    const ws = workspace();
    const attached = [file("attachment://a1", "Zörk dáta.ipynb", '{"cells": 1}'), file("attachment://a2", "Zörk dáta.ipynb", '{"cells": 2}')];
    const first = await ws.run(request({}), attached);
    expect(first.result.files.map((f) => f.name).sort()).toEqual(["attachments/Zork_data-2.ipynb", "attachments/Zork_data.ipynb"]);
    expect(text(kernels[0]!.files.get("attachments/Zork_data-2.ipynb"))).toBe('{"cells": 2}');
    const second = await ws.run(request({}), attached.slice(0, 1));
    expect(second.result.files.map((f) => f.name)).toEqual(["attachments/Zork_data.ipynb"]);
    expect(kernels).toHaveLength(1);
  });

  it("copies host files in once per source and reports the ones it cannot load", async () => {
    const ws = workspace();
    const blob = vi.fn(async () => new Blob(["a,b"]));
    const mounts = { files: [{ path: "uploads/2026/frob.csv", source: "/uploads/2026/frob.csv", blob }, { path: "uploads/gone.csv", source: "/uploads/gone.csv", blob: () => Promise.reject(new Error("No file /uploads/gone.csv.")) }], notes: ["quux is not a site file address."] };
    const first = await ws.run(request({}), [], mounts);
    expect(text(kernels[0]!.files.get("uploads/2026/frob.csv"))).toBe("a,b");
    expect(first.result.notes).toEqual(["quux is not a site file address.", "No file /uploads/gone.csv."]);
    await ws.run(request({}), [], { files: mounts.files.slice(0, 1), notes: [] });
    expect(blob).toHaveBeenCalledTimes(1);
  });

  it("returns figures and shown images as image items and explains what it cannot show", async () => {
    program = (kernel) => {
      kernel.files.set("out/frob.png", PNG);
      kernel.files.set("out/frob.txt", new TextEncoder().encode("quux"));
      return { figures: [btoa(String.fromCharCode(...PNG))] };
    };
    const { result, images } = await workspace().run(request({ code: "plot", show: ["out/frob.png", "out/frob.txt", "out/missing.png"] }));
    expect(images).toEqual([
      { name: "figure-1.png", mimeType: "image/png", data: btoa(String.fromCharCode(...PNG)) },
      { name: "frob.png", mimeType: "image/png", data: btoa(String.fromCharCode(...PNG)) },
    ]);
    expect(result.notes).toEqual(["show: no file out/missing.png in the workspace.", "show: frob.txt is not a PNG, JPEG, GIF, WebP or SVG image."]);
  });

  it("keeps the start and end of long output", async () => {
    program = () => ({ stdout: "A".repeat(10000) + "B".repeat(10000) + "Z" });
    const { stdout } = (await workspace().run(request({ language: "javascript", code: "spam" }))).result;
    expect(stdout.length).toBeLessThan(12100);
    expect(stdout.startsWith("AAAA")).toBe(true);
    expect(stdout.endsWith("BBBZ")).toBe(true);
    expect(stdout).toContain("8001 characters omitted");
  });

  it("starts a fresh kernel after one is lost and mounts the attachments again", async () => {
    const ws = workspace();
    const attached = [file("attachment://a1", "plugh.csv", "x,y")];
    program = (kernel) => {
      kernel.lost = true;
      return { error: "Time limit exceeded (5000 ms)" };
    };
    const lost = (await ws.run(request({ code: "while True: pass" }), attached)).result;
    expect(lost).toMatchObject({ ok: false, error: "Time limit exceeded (5000 ms)", files: [] });
    expect(lost.notes?.[0]).toContain("The workspace was reset");
    expect(kernels[0]!.disposed).toBe(true);
    program = () => ({ stdout: "ok" });
    const again = (await ws.run(request({ code: "print('ok')" }), attached)).result;
    expect(kernels).toHaveLength(2);
    expect(again.files.map((f) => f.name)).toEqual(["attachments/plugh.csv"]);
  });
});
