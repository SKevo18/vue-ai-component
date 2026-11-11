// @skevo18/vue-ai-component/code: the run_code tool and the page side of its kernels. Pyodide is an optional peer:
// the host self-hosts it and passes its folder URL; nothing of it is bundled.
export { createCodeTool, serializeResult } from "./tool";
export type { CodeMounts, CodeToolOptions } from "./tool";
export { attachmentPaths, clipOutput, CODE_LANGUAGES, CodeWorkspace, MAX_FILE_BYTES, OUTPUT_CHARS } from "./workspace";
export type { CodeLanguage, MountedFile, WorkspaceAttachment, WorkspaceImage, WorkspaceRequest, WorkspaceResult } from "./workspace";
export { createWorkerKernel, RunClock } from "./kernel";
export type { KernelTransport, StdinChannel, WorkerKernelOptions } from "./kernel";
export { clip, clipInputs, KERNEL_LOST, OUTPUT_LIMIT, RUN_STOPPED, timeLimitError } from "./types";
export type { InputLine, InputMessage, InputRequest, Kernel, KernelEngine, KernelExecution, KernelFile, KernelIO, KernelRequest, KernelResponse, KernelValue, RunOptions, RunResult, RunStatus } from "./types";
