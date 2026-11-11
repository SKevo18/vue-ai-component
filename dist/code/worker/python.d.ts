import type { KernelEngine, KernelExecution, RunResult } from "../types";
import { type InputFactory } from "./input";
import { type NativeFiles, type NativeFs } from "./native-fs";
export declare const PYTHON_HOME = "/home/pyodide";
export interface PythonFs extends NativeFs {
    rmdir(path: string): void;
}
export interface PackageLoader {
    loadPackage(names: string[], options: {
        messageCallback: (message: string) => void;
        errorCallback: (message: string) => void;
    }): Promise<unknown>;
    runPythonAsync(code: string): Promise<unknown>;
}
export interface Pyodide extends PackageLoader {
    FS: PythonFs;
    globals: {
        get(name: string): unknown;
    };
    runPython(code: string): unknown;
    /** the lockfile Pyodide loaded with */
    readonly lockfile: {
        packages?: Record<string, {
            name?: string;
            depends?: string[];
        }>;
    };
    loadPackagesFromImports(code: string, options: {
        messageCallback: (message: string) => void;
        errorCallback: (message: string) => void;
    }): Promise<unknown>;
    setStdout(options: {
        write: (bytes: Uint8Array) => number;
        isatty?: boolean;
    }): void;
    setStderr(options: {
        write: (bytes: Uint8Array) => number;
        isatty?: boolean;
    }): void;
    setStdin(options: {
        stdin: () => string | null;
    }): void;
}
/** Pyodide lockfile entries by normalised name: the lockfile's own key and its dependencies. */
export type LockIndex = Record<string, {
    key: string;
    depends: string[];
}>;
/** PEP 503 normalised project name. */
export declare function normalizeName(name: string): string;
/** The lookup of a parsed `pyodide-lock.json`. */
export declare function lockIndex(lock: {
    packages?: Record<string, {
        name?: string;
        depends?: string[];
    }>;
}): LockIndex;
/** Loads Pyodide from `indexURL` (a folder URL ending in `/`); each caller owns the interpreter. */
export declare function loadPython(indexURL: string): Promise<{
    py: Pyodide;
    lock: LockIndex;
}>;
/** Loads the named packages of the Pyodide distribution; an error message names the ones it does not have. */
export declare function installFromLock(py: PackageLoader, lock: LockIndex, names: string[]): Promise<string | undefined>;
export interface PythonEngineOptions<E extends KernelExecution> {
    /** interactive input; the default reads the run's pre-filled stdin */
    input?: InputFactory<E>;
    /** loads the run's packages and returns an error message; the default takes them from the Pyodide distribution */
    install?(py: Pyodide, lock: LockIndex, names: string[], options: E): Promise<string | undefined>;
    /** packages the workspace itself asks for, such as a requirements.txt */
    packages?(files: NativeFiles, options: E): string[];
    /** also loads the distribution packages the program imports (Pyodide's loadPackagesFromImports) */
    importedPackages?: boolean;
}
/** Retains the interpreter, its module registry, user namespace and files under PYTHON_HOME. */
export declare function createPythonEngine<E extends KernelExecution = KernelExecution, R extends RunResult = RunResult>(indexURL: string, hooks?: PythonEngineOptions<E>): Promise<KernelEngine<E, R>>;
