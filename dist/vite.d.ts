import type { Plugin } from "vite";
/** The content security policy the host serves the run_code workers with (`<dir>/code-<hash>/`). */
export declare const CODE_WORKER_CSP = "default-src 'none'; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'";
export interface CodeAssetsOptions {
    /** output folder and URL path below the site root, default "assets" */
    dir?: string;
    /** Pyodide packages to host with their dependencies, default numpy, pandas and matplotlib */
    packages?: string[];
    /** where the wheels download from, `{version}` is the Pyodide version */
    cdn?: string;
}
export declare function codeAssets(options?: CodeAssetsOptions): Plugin;
