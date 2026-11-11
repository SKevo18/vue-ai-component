import { defineConfig } from "vite";

// The run_code workers as self-contained files in dist/code-workers/, served by the host (codeAssets in ./vite).
// JavaScript needs a classic worker (one IIFE script, importScripts keeps its globals); Python is a module worker.
const python = process.env.WORKER === "python";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/code-workers",
    emptyOutDir: !python,
    target: "es2022",
    lib: python
      ? { entry: "src/code/workers/python.ts", formats: ["es"], fileName: () => "python-worker.js" }
      : { entry: "src/code/workers/javascript.ts", formats: ["iife"], name: "RunCodeWorker", fileName: () => "javascript-worker.js" },
    sourcemap: false,
    minify: true,
  },
});
