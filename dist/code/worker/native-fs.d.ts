import type { KernelFile } from "../types";
/** The part of an Emscripten file system (Pyodide's `FS`) the workspace uses. */
export interface NativeFs {
    readdir(path: string): string[];
    /** like stat, but describes a symlink itself */
    lstat(path: string): {
        mode: number;
        size: number;
    };
    readFile(path: string): Uint8Array;
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
}
/** A workspace file name: relative, `/` separated, without empty, `.` or `..` parts. */
export declare function fileName(name: string): string;
export interface NativeFiles {
    listFiles(): KernelFile[];
    readFile(name: string): Uint8Array;
    writeFile(name: string, data: Uint8Array): void;
    removeFile(name: string): void;
}
/** The regular files under `root` as a kernel's file API; writing creates missing folders. */
export declare function nativeFiles(fs: NativeFs, root: string): NativeFiles;
