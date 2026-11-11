// The run_code Python worker (module, built as one file into dist/code-workers/). The first request carries the
// Pyodide folder; the worker reaches nothing else.
import { hardenWorker } from "../worker/harden";
import { createPythonEngine } from "../worker/python";
import { serveKernel } from "../worker/serve";

serveKernel((initial) => {
  const { indexURL } = initial;
  if (typeof indexURL !== "string" || !indexURL.endsWith("/")) throw new Error("Missing Python runtime URL");
  hardenWorker([new URL(indexURL).pathname]);
  return createPythonEngine(indexURL, { importedPackages: true });
});
