import { describe, expect, it } from "vitest";
import { JavaScriptFiles } from "./javascript-fs";

interface ModuleTarget {
  require(name: string): unknown;
}
interface FsModule {
  readFileSync(name: string, encoding?: string): Uint8Array | string;
  writeFileSync(name: string, data: string | Uint8Array): void;
  appendFileSync(name: string, data: string | Uint8Array): void;
  unlinkSync(name: string): void;
  readdirSync(name?: string): string[];
}

const encoder = new TextEncoder();

describe("JavaScript retained files", () => {
  it("keeps exact private bytes rather than lossy text or borrowed buffers", () => {
    const files = new JavaScriptFiles();
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    files.writeFile("samples/odd.bin", bytes);
    bytes.fill(4);
    const result = files.readFile("./samples/odd.bin");
    expect([...result]).toEqual([0, 255, 128, 13, 10]);
    result.fill(7);
    expect([...files.readFile("samples/odd.bin")]).toEqual([0, 255, 128, 13, 10]);
    expect(files.listFiles()).toEqual([{ name: "samples/odd.bin", size: 5 }]);
  });

  it("shares fs module writes and deletes with explorer storage", () => {
    const files = new JavaScriptFiles();
    const target = {} as ModuleTarget;
    files.installCommonJS(target);
    const fs = target.require("node:fs") as FsModule;
    expect(target.require("fs")).toBe(fs);
    fs.writeFileSync("data/raw.bin", new Uint8Array([255, 0]));
    fs.appendFileSync("data/raw.bin", new Uint8Array([192]));
    fs.writeFileSync("data/správa.txt", "žaba");
    expect([...files.readFile("data/raw.bin")]).toEqual([255, 0, 192]);
    expect(fs.readFileSync("data/správa.txt", "utf8")).toBe("žaba");
    expect(fs.readdirSync("data")).toEqual(["raw.bin", "správa.txt"]);
    fs.unlinkSync("data/raw.bin");
    expect(() => files.readFile("data/raw.bin")).toThrow("ENOENT");
    expect(files.listFiles()).toEqual([{ name: "data/správa.txt", size: 5 }]);
  });

  it("retains CommonJS object identity and closures even when source files change", () => {
    const files = new JavaScriptFiles();
    files.writeFile("nested/state.js", encoder.encode("let value = 0; module.exports = () => ++value;"));
    files.writeFile("nested/entry.js", encoder.encode("module.exports = require('./state');"));
    const target = {} as ModuleTarget;
    files.installCommonJS(target);
    const counter = target.require("./nested/entry") as () => number;
    expect(counter()).toBe(1);
    files.writeFile("nested/state.js", encoder.encode("throw new Error('do not replay')"));
    expect(target.require("nested/state")).toBe(counter);
    expect(counter()).toBe(2);
  });

  it("does not retain a failed module and prevents files escaping or replacing directories", () => {
    const files = new JavaScriptFiles();
    const target = {} as ModuleTarget;
    files.installCommonJS(target);
    files.writeFile("broken.js", encoder.encode("throw new Error('snork')"));
    expect(() => target.require("broken")).toThrow("snork");
    files.writeFile("broken.js", encoder.encode("module.exports = 37"));
    expect(target.require("broken")).toBe(37);
    expect(() => files.writeFile("../escape", new Uint8Array())).toThrow("working directory");
    files.writeFile("dir/inner", new Uint8Array());
    expect(() => files.writeFile("dir", new Uint8Array())).toThrow("conflict");
    expect(() => files.writeFile("broken.js/inner", new Uint8Array())).toThrow("conflict");
  });
});
