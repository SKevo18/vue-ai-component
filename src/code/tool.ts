// run_code: a local HarnessTool that runs Python (Pyodide) or JavaScript in workers of this tab, in one workspace per
// conversation, with the chat's attachments under attachments/.
import type { Approval, ImageRef } from "../core/entries";
import type { HarnessTool, ToolContext, ToolResult } from "../core/tools";
import type { JsonSchema } from "../core/types";
import { createWorkerKernel } from "./kernel";
import type { Kernel } from "./types";
import { CODE_LANGUAGES, CodeWorkspace, type CodeLanguage, type MountedFile } from "./workspace";

/** Files the host copies into the workspace, chosen by its own run_code arguments (e.g. site files by address). */
export interface CodeMounts {
  /** extra run_code argument schemas, e.g. `{ uploads: { type: "array", items: { type: "string" } } }` */
  parameters: Record<string, JsonSchema>;
  /** a sentence for the tool description saying where the files land */
  description?: string;
  /** the files to mount for this call; `notes` reach the model (a file that could not be found) */
  files(args: Record<string, unknown>, signal: AbortSignal): Promise<{ files: MountedFile[]; notes: string[] }>;
}

export interface CodeToolOptions {
  /** URL of the folder serving dist/code-workers/ (javascript-worker.js, python-worker.js), e.g. "/assets/code/" */
  assetsUrl?: string;
  /** URL of the self-hosted Pyodide folder (pyodide.mjs, pyodide-lock.json, packages), e.g. "/assets/pyodide/" */
  pyodideUrl?: string;
  /** default: python when Pyodide (or `kernel`) is there, and javascript */
  languages?: CodeLanguage[];
  /** the host's own kernels (its own workers, policies and time limits) instead of the bundled workers */
  kernel?(language: CodeLanguage): Kernel;
  /** time limit of one run, default 120 s */
  timeLimitMs?: number;
  /** a refusal message for Python packages the host does not allow, or null */
  packagePolicy?(packages: string[]): string | null;
  mounts?: CodeMounts;
  /** extra guidance appended to the tool description */
  description?: string;
  /** default "auto": the code runs sandboxed in this tab and the user sees it */
  approval?: Approval;
}

/** String fields that leave the JSON head when they span lines, so long text reaches the model unescaped. */
const RAW_FIELDS: Record<string, true> = { text: true, stdout: true, stderr: true, error: true };

/** A result object as one JSON line followed by its multi-line text fields as `--- field ---` sections. */
export function serializeResult(value: Record<string, unknown>): string {
  const head: Record<string, unknown> = {};
  const sections: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string" && RAW_FIELDS[key] && v.includes("\n")) sections.push(`--- ${key} ---\n${v}`);
    else head[key] = v;
  }
  return [JSON.stringify(head), ...sections].join("\n");
}

function folder(url: string): URL {
  const resolved = new URL(url, location.href);
  if (!resolved.pathname.endsWith("/")) resolved.pathname += "/";
  return resolved;
}

/** The bundled workers served from `assetsUrl`. */
function bundledKernel(options: CodeToolOptions): (language: CodeLanguage) => Kernel {
  return (language) => {
    const assets = folder(options.assetsUrl!);
    if (language === "javascript") return createWorkerKernel(() => new Worker(new URL("javascript-worker.js", assets), { name: "run_code javascript" }));
    const indexURL = folder(options.pyodideUrl!).href;
    return createWorkerKernel(() => new Worker(new URL("python-worker.js", assets), { type: "module", name: "run_code python" }), {
      transport: {
        send(worker, request) {
          worker.postMessage({ ...request, indexURL });
        },
      },
    });
  };
}

export function createCodeTool(options: CodeToolOptions): HarnessTool {
  const available = options.kernel ? CODE_LANGUAGES : CODE_LANGUAGES.filter((language) => options.assetsUrl && (language === "javascript" || options.pyodideUrl));
  const languages = (options.languages ?? available).filter((language) => available.includes(language));
  if (!languages.length) throw new Error("createCodeTool needs assetsUrl (and pyodideUrl for Python) or a kernel factory.");
  const createKernel = options.kernel ?? bundledKernel(options);
  const timeoutMs = options.timeLimitMs ?? 120_000;
  let current: { conversationId: string; workspace: CodeWorkspace } | null = null;

  const python = languages.includes("python");
  const description = [
    `Runs ${languages.map((language) => (language === "python" ? "Python (Pyodide)" : "JavaScript")).join(" or ")} in a sandbox in the user's browser, in a workspace kept for this conversation: variables, imports and files persist between calls until the page reloads or the conversation changes (a time limit or crash resets it). Files attached to the conversation are mounted as attachments/<name>; the result lists the workspace files.`,
    options.mounts?.description,
    `Use it to inspect large or binary files without reading them whole, to parse and analyse data and to calculate instead of doing arithmetic in your head. stdout, stderr and error are cut to 12000 characters each (start and end kept): print summaries, not whole files.`,
    languages.includes("javascript") ? "JavaScript runs as a classic script: console.log prints, fs.readFileSync/writeFileSync/readdirSync and require(\"fs\") work on the workspace files, top-level declarations persist." : undefined,
    python ? "Python allows top-level await; matplotlib figures come back as images you can see." : undefined,
    "Image files named in show (PNG, JPEG, GIF, WebP, SVG) come back as images. No network access. The user sees the code and the output.",
    options.description,
  ]
    .filter(Boolean)
    .join(" ");

  const parameters: JsonSchema = {
    type: "object",
    properties: {
      language: { type: "string", enum: [...languages], description: "Each language has its own interpreter and files." },
      code: { type: "string", minLength: 1, description: python ? "Program to run; Python allows top-level await." : "Program to run." },
      ...(python && { packages: { type: "array", items: { type: "string" }, description: 'Python packages to load first, e.g. ["numpy", "pandas", "matplotlib"]. Imports of distribution packages also load on their own.' } }),
      show: { type: "array", items: { type: "string" }, description: "Workspace paths of image files to look at after the run." },
      ...options.mounts?.parameters,
    },
    required: ["language", "code"],
    additionalProperties: false,
  };

  async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const language = args.language as CodeLanguage;
    if (!languages.includes(language)) return { text: `run_code runs ${languages.join(" or ")}, not ${String(language)}.`, isError: true };
    const packages = Array.isArray(args.packages) ? (args.packages as string[]) : undefined;
    const refused = language === "python" && packages?.length ? options.packagePolicy?.(packages) : null;
    if (refused) return { text: refused, isError: true };
    if (current?.conversationId !== ctx.conversationId) {
      current?.workspace.dispose();
      current = { conversationId: ctx.conversationId, workspace: new CodeWorkspace(createKernel) };
    }
    const { workspace } = current;
    const attachments = (await ctx.files()).map((file) => ({ id: file.uri, name: file.name, blob: file.blob }));
    const mounts = options.mounts ? await options.mounts.files(args, ctx.signal) : undefined;
    ctx.onProgress?.(`Running ${language}`);
    const { result, images } = await workspace.run(
      { language, code: String(args.code), packages, show: Array.isArray(args.show) ? (args.show as string[]) : undefined, timeoutMs, signal: ctx.signal },
      attachments,
      mounts,
    );
    const saved: ImageRef[] = [];
    for (const image of images) saved.push(await ctx.saveImage({ mimeType: image.mimeType, data: image.data }, image.name));
    return { text: serializeResult({ ...result, ...(images.length && { images: images.map((image) => image.name) }) }), images: saved.length ? saved : undefined };
  }

  return {
    name: "run_code",
    title: "Run code",
    description,
    parameters,
    approval: options.approval ?? "auto",
    readOnly: false,
    run,
  };
}
