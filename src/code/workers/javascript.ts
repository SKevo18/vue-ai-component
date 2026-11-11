// The run_code JavaScript worker (classic, built as one script into dist/code-workers/). No network at all.
import "../worker/classic-script";
import { createJavaScriptEngine } from "../worker/javascript";
import { hardenWorker } from "../worker/harden";
import { serveKernel } from "../worker/serve";

hardenWorker([]);
const engine = createJavaScriptEngine();
serveKernel(() => engine);
