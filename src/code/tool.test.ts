// @vitest-environment node
// run_code through the harness with the real JavaScript and Python engines in this process. The worker boundary
// (createWorkerKernel) has its own tests; here a classic worker's global scripts are node:vm scripts in this realm,
// which share top-level declarations the same way.
import "fake-indexeddb/auto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { componentAi } from "../../test/component-ai";
import { scriptedTransport, toolOutputs, type FakeTurn, type ResponsesInputItem } from "../../test/fake-provider";
import type { ToolEntry } from "../core/entries";
import { createCodeTool } from "./tool";
import type { Kernel, KernelEngine } from "./types";
import { createJavaScriptEngine } from "./worker/javascript";
import { createPythonEngine } from "./worker/python";

vi.hoisted(() => {
  const { runInThisContext } = process.getBuiltinModule("node:vm");
  const sources = new Map<string, string>();
  class SourceBlob extends Blob {
    readonly source: string;
    constructor(parts: string[], options?: BlobPropertyBag) {
      super(parts, options);
      this.source = parts.join("");
    }
  }
  Object.assign(globalThis, {
    self: globalThis,
    Blob: SourceBlob,
    addEventListener: () => undefined,
    importScripts: (...urls: string[]) => urls.forEach((url) => runInThisContext(sources.get(url)!)),
  });
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:run-code/${sources.size}`;
    sources.set(url, (blob as SourceBlob).source);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void sources.delete(url);
});

/** The engine behind a kernel without the worker in between. */
function inProcess(engine: KernelEngine): Kernel {
  const io = { status: () => undefined, input: () => undefined };
  return {
    lost: false,
    execute: async (source, options) => ({ ...(await engine.execute(source, { stdin: options.stdin ?? "", stdinRun: null, packages: options.packages ?? [] }, io)), duration_ms: 1 }),
    listFiles: async () => engine.listFiles(),
    readFile: async (name) => engine.readFile(name),
    writeFile: async (name, data) => engine.writeFile(name, data),
    removeFile: async (name) => engine.removeFile(name),
    dispose: () => undefined,
  };
}

/** One run_code call per user message (the message is its arguments as JSON), then the result as the answer. */
const transport = scriptedTransport((input: ResponsesInputItem[]): FakeTurn => {
  const at = input.length - 1 - [...input].reverse().findIndex((i) => i.role === "user");
  const outputs = toolOutputs(input.slice(at));
  if (outputs.length) return { text: "done" };
  const text = typeof input[at]!.content === "string" ? input[at]!.content : (input[at]!.content as { text: string }[])[0]!.text;
  return { calls: [{ name: "run_code", args: JSON.parse(text.split("\n\n[Attached")[0]!) }] };
});

const javascript = inProcess(createJavaScriptEngine());
const pyodide = fileURLToPath(new URL("../../node_modules/pyodide/", import.meta.url));
// matplotlib wheels come from the Pyodide CDN the first time (Pyodide caches them in its folder)
const pythonReady = existsSync(`${pyodide}pyodide.mjs`) && (await fetch(`https://cdn.jsdelivr.net/pyodide/v${JSON.parse(readFileSync(`${pyodide}package.json`, "utf8")).version}/full/pyodide-lock.json`, { method: "HEAD", signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false));

function lastRun(entries: { role: string }[]): ToolEntry {
  return entries.findLast((e): e is ToolEntry => e.role === "tool")!;
}

/** The run's result: the JSON head with its `--- field ---` sections put back. */
function result(entry: ToolEntry): Record<string, unknown> {
  const [head, ...sections] = entry.content.split("\n--- ");
  const out = JSON.parse(head!) as Record<string, unknown>;
  for (const section of sections) {
    const newline = section.indexOf("\n");
    out[section.slice(0, newline).replace(/ ---$/, "")] = section.slice(newline + 1);
  }
  return out;
}

describe("run_code", () => {
  it("reads an attached file through fs and require in a JavaScript workspace kept for the chat", async () => {
    const ai = componentAi({ tools: [createCodeTool({ kernel: () => javascript, languages: ["javascript"] })], storagePrefix: "run-code-js:" }, { transport: () => transport });
    await ai.init();
    await ai.attachText("name,legs\nzorp,3\nquux,5\n", "Beasts list.csv");
    const code = 'const rows = fs.readFileSync("attachments/Beasts_list.csv", "utf8").trim().split("\\n").slice(1).map((l) => l.split(","));\nlet total = rows.reduce((s, r) => s + Number(r[1]), 0);\nrequire("fs").writeFileSync("out/total.json", JSON.stringify({ total }));\nconsole.log("legs", total);';
    await ai.send(JSON.stringify({ language: "javascript", code }));
    const first = lastRun(ai.state.entries);
    expect(first.status).toBe("done");
    expect(result(first)).toMatchObject({ language: "javascript", ok: true, stdout: "legs 8\n", files: [{ name: "attachments/Beasts_list.csv", size: 24 }, { name: "out/total.json", size: 11 }] });

    await ai.send(JSON.stringify({ language: "javascript", code: 'console.log(total * 2, fs.readdirSync("out"), require("./out/total.json").total)' }));
    expect(result(lastRun(ai.state.entries))).toMatchObject({ ok: true, stdout: '16 ["total.json"] 8\n' });

    await ai.send(JSON.stringify({ language: "javascript", code: "throw new TypeError('plugh broke')" }));
    expect(result(lastRun(ai.state.entries))).toMatchObject({ ok: false, error: expect.stringContaining("TypeError: plugh broke") });
  });

  it("offers only the languages it can run and refuses packages the host does not allow", async () => {
    expect(() => createCodeTool({})).toThrow("assetsUrl");
    const tool = createCodeTool({ assetsUrl: "/assets/code/" });
    expect(tool.parameters.properties!.language!.enum).toEqual(["javascript"]);
    const python = createCodeTool({ kernel: () => javascript, packagePolicy: () => "frob is not allowed" });
    const ctx = { signal: new AbortController().signal, conversationId: "c", saveImage: async () => ({ uri: "attachment://x" }), files: async () => [] };
    expect(await python.run({ language: "python", code: "import frob", packages: ["frob"] }, ctx)).toEqual({ text: "frob is not allowed", isError: true });
  });

  it.skipIf(!pythonReady)("plots an attached CSV with matplotlib and returns the figure as an image", { timeout: 180_000 }, async () => {
    const python = inProcess(await createPythonEngine(pyodide, { importedPackages: true }));
    const ai = componentAi({ tools: [createCodeTool({ kernel: () => python, languages: ["python"] })], storagePrefix: "run-code-py:" }, { transport: () => transport });
    await ai.init();
    await ai.attachText("day,cups\n1,3\n2,5\n3,4\n", "coffee.csv");
    const code = "import csv\nimport matplotlib.pyplot as plt\nrows = list(csv.DictReader(open('attachments/coffee.csv')))\nplt.plot([int(r['day']) for r in rows], [int(r['cups']) for r in rows])\nprint(sum(int(r['cups']) for r in rows))";
    await ai.send(JSON.stringify({ language: "python", code }));
    const run = lastRun(ai.state.entries);
    expect(result(run)).toMatchObject({ language: "python", ok: true, stdout: "12\n", images: ["figure-1.png"] });
    expect(run.images).toHaveLength(1);
    const files = await ai.files();
    expect(files.map((f) => f.name)).toContain("coffee.csv");
  });
});
