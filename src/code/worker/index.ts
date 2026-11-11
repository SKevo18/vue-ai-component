// Worker side of @skevo18/vue-ai-component/code, for hosts that build their own kernel workers. Import it before
// any module that replaces importScripts: runGlobalScript keeps the worker's own.
export { runGlobalScript } from "./classic-script";
export { serveKernel } from "./serve";
export { allowedUrl, hardenWorker } from "./harden";
export { fileName, nativeFiles } from "./native-fs";
export type { NativeFiles, NativeFs } from "./native-fs";
export { JavaScriptFiles } from "./javascript-fs";
export { createJavaScriptEngine, errorText } from "./javascript";
export type { JavaScriptEngineOptions, JavaScriptRun } from "./javascript";
export { createPythonEngine, installFromLock, loadPython, lockIndex, normalizeName, PYTHON_HOME } from "./python";
export type { LockIndex, PackageLoader, Pyodide, PythonEngineOptions, PythonFs } from "./python";
export { prefilledInput } from "./input";
export type { InputFactory, InputSource, OutputSoFar } from "./input";
export type { InputLine, InputMessage, InputRequest, KernelEngine, KernelExecution, KernelFile, KernelIO, KernelRequest, KernelResponse, KernelValue, RunResult, RunStatus } from "../types";
