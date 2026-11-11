/**
 * Whether a worker may fetch `raw` (resolved against `base`, the worker's own URL): same origin, a path under one of
 * `prefixes`. Encoded slashes, backslashes and dots are refused: proxies decode and normalise them before routing.
 */
export declare function allowedUrl(raw: string, base: string, prefixes: readonly string[]): boolean;
/** Confines this worker's network to same-origin `prefixes` (path prefixes such as "/assets/pyodide/"). */
export declare function hardenWorker(prefixes: readonly string[]): void;
