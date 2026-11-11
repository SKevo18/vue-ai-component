// Network hardening of a worker that runs user code. fetch and importScripts reach only same-origin paths under the
// allowed prefixes, without credentials; every other network and worker API is removed. Call it before user code
// runs; modules that need a removed API (classic-script.ts) take it before.

const BLOCKED = ["XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "BroadcastChannel", "Worker", "SharedWorker", "WebTransport", "RTCPeerConnection", "caches", "fetchLater"];

/**
 * Whether a worker may fetch `raw` (resolved against `base`, the worker's own URL): same origin, a path under one of
 * `prefixes`. Encoded slashes, backslashes and dots are refused: proxies decode and normalise them before routing.
 */
export function allowedUrl(raw: string, base: string, prefixes: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return false;
  }
  if (url.origin !== new URL(base).origin || url.username || url.password) return false;
  if (/%2f|%5c|%2e|\\/i.test(url.pathname)) return false;
  return prefixes.some((prefix) => url.pathname.startsWith(prefix));
}

/** Replaces `name` on the global object and every prototype that defines it, so no original stays reachable. */
function replace(name: string, value: unknown) {
  for (let o: object | null = self; o; o = Object.getPrototypeOf(o)) {
    if (Object.hasOwn(o, name)) Object.defineProperty(o, name, { value, writable: false, configurable: false, enumerable: false });
  }
}

/** Confines this worker's network to same-origin `prefixes` (path prefixes such as "/assets/pyodide/"). */
export function hardenWorker(prefixes: readonly string[]): void {
  const base = self.location.href;
  const nativeFetch = self.fetch.bind(self);
  // module workers have importScripts too (it throws); classic-style loaders such as Pyodide's try it first
  const nativeImportScripts: unknown = "importScripts" in self ? self.importScripts : undefined;
  const blocked = (url: string) => new TypeError(`Network access is not allowed: ${url}`);
  replace("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!allowedUrl(url, base, prefixes)) return Promise.reject(blocked(url));
    return nativeFetch(new Request(input, { ...init, credentials: "omit" }));
  });
  if (nativeImportScripts)
    replace("importScripts", (...urls: string[]) => {
      for (const url of urls) if (!allowedUrl(url, base, prefixes)) throw blocked(url);
      if (typeof nativeImportScripts === "function") nativeImportScripts.apply(self, urls);
    });
  for (const name of BLOCKED) replace(name, undefined);
}
