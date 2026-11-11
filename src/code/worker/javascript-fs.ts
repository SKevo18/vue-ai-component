import type { KernelFile } from "../types";

type Encoding = "utf8" | "utf-8";
interface CommonJSModule { exports: unknown }

/** A private byte store shared by the kernel explorer and JavaScript's fs/CommonJS APIs. */
export class JavaScriptFiles {
  private readonly files = new Map<string, Uint8Array>();
  private readonly cache = new Map<string, CommonJSModule>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private path(name: string): string {
    if (typeof name !== "string" || name.includes("\0") || name.includes("\\")) throw new Error("Invalid file path");
    const parts: string[] = [];
    for (const part of name.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) throw new Error("File path leaves the working directory");
        parts.pop();
      } else parts.push(part);
    }
    return parts.join("/");
  }

  listFiles(): KernelFile[] {
    return [...this.files].map(([name, data]) => ({ name, size: data.byteLength })).sort((a, b) => a.name.localeCompare(b.name));
  }

  readFile(name: string): Uint8Array {
    const key = this.path(name);
    const data = this.files.get(key);
    if (!data) throw new Error(`ENOENT: no such file, '${name}'`);
    return data.slice();
  }

  readText(name: string): string {
    return this.decoder.decode(this.readFile(name));
  }

  writeFile(name: string, data: Uint8Array): void {
    const key = this.path(name);
    if (!key) throw new Error("A file name is required");
    for (const existing of this.files.keys()) {
      if (existing.startsWith(key + "/") || key.startsWith(existing + "/")) throw new Error(`File and directory conflict: '${name}'`);
    }
    this.files.set(key, data.slice());
  }

  removeFile(name: string): void {
    if (!this.files.delete(this.path(name))) throw new Error(`ENOENT: no such file, '${name}'`);
  }

  /** Text projection for assignment test contexts, never used to restore interpreter storage. */
  textFiles(): Record<string, string> {
    return Object.fromEntries([...this.files].map(([name, data]) => [name, this.decoder.decode(data)]));
  }

  installCommonJS(target: object): void {
    const encodingName = (encoding?: string | { encoding?: string | null } | null) => {
      const value = typeof encoding === "object" ? encoding?.encoding : encoding;
      if (value && value !== "utf8" && value !== "utf-8") throw new Error(`Unsupported encoding '${value}'`);
      return value;
    };
    const fs = {
      readFileSync: (name: string, encoding?: Encoding | { encoding?: Encoding | null } | null) => encodingName(encoding) ? this.readText(name) : this.readFile(name),
      writeFileSync: (name: string, data: string | Uint8Array, encoding?: Encoding | { encoding?: Encoding }) => {
        encodingName(encoding);
        this.writeFile(name, typeof data === "string" ? this.encoder.encode(data) : data);
      },
      appendFileSync: (name: string, data: string | Uint8Array, encoding?: Encoding | { encoding?: Encoding }) => {
        encodingName(encoding);
        const old = this.files.get(this.path(name));
        const addition = typeof data === "string" ? this.encoder.encode(data) : data;
        const joined = new Uint8Array((old?.byteLength ?? 0) + addition.byteLength);
        if (old) joined.set(old);
        joined.set(addition, old?.byteLength ?? 0);
        this.writeFile(name, joined);
      },
      unlinkSync: (name: string) => this.removeFile(name),
      existsSync: (name: string) => {
        const key = this.path(name);
        return !key || this.files.has(key) || [...this.files.keys()].some((path) => path.startsWith(key + "/"));
      },
      readdirSync: (name = ".") => {
        const key = this.path(name);
        if (this.files.has(key)) throw new Error(`ENOTDIR: not a directory, '${name}'`);
        const prefix = key ? key + "/" : "";
        const names = [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]!);
        if (key && !names.length) throw new Error(`ENOENT: no such directory, '${name}'`);
        return [...new Set(names)].sort();
      },
    };
    const requireFrom = (name: string, directory: string): unknown => {
      if (name === "fs" || name === "node:fs") return fs;
      const path = this.path(name.startsWith(".") ? directory + name : name);
      const key = [path, `${path}.js`, `${path}.mjs`, `${path}.json`, `${path}/index.js`].find((candidate) => this.files.has(candidate));
      if (!key) throw new Error(`Cannot find module '${name}'`);
      const previous = this.cache.get(key);
      if (previous) return previous.exports;
      const module: CommonJSModule = { exports: {} };
      this.cache.set(key, module);
      try {
        if (key.endsWith(".json")) module.exports = JSON.parse(this.readText(key));
        else {
          const dirname = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
          new Function("require", "module", "exports", "__filename", "__dirname", this.readText(key))((name: string) => requireFrom(name, dirname), module, module.exports, key, dirname.replace(/\/$/, "") || ".");
        }
      } catch (error) {
        this.cache.delete(key);
        throw error;
      }
      return module.exports;
    };
    const module: CommonJSModule = { exports: {} };
    Object.assign(target, { fs, require: (name: string) => requireFrom(name, ""), module, exports: module.exports });
  }
}
