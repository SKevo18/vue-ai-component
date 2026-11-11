// Runs source as a native classic global script, so its top-level declarations persist between runs. It takes the
// worker's own importScripts when this module evaluates, before hardenWorker replaces it: import it first.
interface ClassicWorkerGlobal {
  importScripts?(...urls: string[]): void;
}
const native = (globalThis as ClassicWorkerGlobal).importScripts;
const importScript = typeof native === "function" ? native.bind(globalThis) : undefined;
const createURL = URL.createObjectURL.bind(URL);
const revokeURL = URL.revokeObjectURL.bind(URL);
const ScriptBlob = Blob;

export function runGlobalScript(source: string): void {
  if (!importScript) throw new Error("JavaScript runs only in a classic worker");
  const url = createURL(new ScriptBlob([source], { type: "text/javascript" }));
  try {
    importScript(url);
  } finally {
    revokeURL(url);
  }
}
