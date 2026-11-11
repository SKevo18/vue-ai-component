import type { KernelFile } from "../types";

/** The part of an Emscripten file system (Pyodide's `FS`) the workspace uses. */
export interface NativeFs {
  readdir(path: string): string[];
  /** like stat, but describes a symlink itself */
  lstat(path: string): { mode: number; size: number };
  readFile(path: string): Uint8Array;
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** A workspace file name: relative, `/` separated, without empty, `.` or `..` parts. */
export function fileName(name: string): string {
  const path = name.startsWith("/") ? name.slice(1) : name;
  if (!path || path.includes("\0") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Invalid file path: ${name}`);
  return path;
}

export interface NativeFiles {
  listFiles(): KernelFile[];
  readFile(name: string): Uint8Array;
  writeFile(name: string, data: Uint8Array): void;
  removeFile(name: string): void;
}

/** The regular files under `root` as a kernel's file API; writing creates missing folders. */
export function nativeFiles(fs: NativeFs, root: string): NativeFiles {
  const base = root === "/" ? "" : root.replace(/\/$/, "");
  function path(name: string, parents = false): string {
    const parts = fileName(name).split("/");
    let dir = base;
    for (const part of parts.slice(0, -1)) {
      dir += "/" + part;
      let stat;
      try {
        stat = fs.lstat(dir);
      } catch (error) {
        if (!parents) throw error;
        fs.mkdir(dir);
        stat = fs.lstat(dir);
      }
      if ((stat.mode & S_IFMT) !== S_IFDIR) throw new Error(`Not a directory: ${dir}`);
    }
    const target = dir + "/" + parts[parts.length - 1];
    let stat;
    try {
      stat = fs.lstat(target);
    } catch {
      return target;
    }
    if ((stat.mode & S_IFMT) !== S_IFREG) throw new Error(`Not a regular file: ${name}`);
    return target;
  }
  return {
    listFiles() {
      const files: KernelFile[] = [];
      const pending = [{ path: base || "/", prefix: "" }];
      while (pending.length) {
        const dir = pending.pop()!;
        for (const entry of fs.readdir(dir.path)) {
          if (entry === "." || entry === "..") continue;
          const target = `${dir.path.replace(/\/$/, "")}/${entry}`;
          const name = dir.prefix + entry;
          const stat = fs.lstat(target);
          if ((stat.mode & S_IFMT) === S_IFDIR) pending.push({ path: target, prefix: name + "/" });
          else if ((stat.mode & S_IFMT) === S_IFREG) files.push({ name, size: stat.size });
        }
      }
      return files.sort((a, b) => a.name.localeCompare(b.name));
    },
    readFile: (name) => fs.readFile(path(name)),
    writeFile: (name, data) => fs.writeFile(path(name, true), data),
    removeFile: (name) => fs.unlink(path(name)),
  };
}
