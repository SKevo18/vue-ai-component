// @vitest-environment node
// Real Pyodide from the pyodide dev dependency. Matplotlib wheels come from the Pyodide CDN (Pyodide caches them in
// its folder), so those tests skip offline.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelEngine, KernelExecution, KernelIO } from "../types";
import { createPythonEngine } from "./python";

const indexURL = fileURLToPath(new URL("../../../node_modules/pyodide/", import.meta.url));
const installed = existsSync(`${indexURL}pyodide.mjs`);
const wheels = installed && readdirSync(indexURL).some((file) => file.startsWith("matplotlib-") && file.endsWith(".whl"));
const cdn = installed && `https://cdn.jsdelivr.net/pyodide/v${JSON.parse(readFileSync(`${indexURL}package.json`, "utf8")).version}/full/pyodide-lock.json`;
const online = wheels || (cdn && (await fetch(cdn, { method: "HEAD", signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false)));
const options: KernelExecution = { stdin: "", stdinRun: null, packages: [] };
const io: KernelIO = { status: () => {}, input: () => {} };

describe.skipIf(!installed)("python kernel", { timeout: 60_000 }, () => {
  let engine: KernelEngine;
  beforeAll(async () => {
    engine = await createPythonEngine(indexURL);
  }, 60_000);

  it("keeps variables and files between runs and reads pre-filled input", async () => {
    const first = await engine.execute('quux = 41\nwith open("frob.txt", "w") as f:\n    f.write("zorp")\nname = input()', { ...options, stdin: "plugh\n" }, io);
    expect(first.error).toBeUndefined();
    expect(first.inputs).toEqual([{ at: 0, text: "plugh" }]);
    const second = await engine.execute("print(quux + 1, name, open('frob.txt').read())", options, io);
    expect(second.stdout).toBe("42 plugh zorp\n");
    expect(await engine.listFiles()).toContainEqual({ name: "frob.txt", size: 4 });
    await engine.writeFile("attachments/data.csv", new TextEncoder().encode("a,b\n1,2\n"));
    const read = await engine.execute("import csv\nprint(list(csv.reader(open('attachments/data.csv'))))", options, io);
    expect(read.stdout).toBe("[['a', 'b'], ['1', '2']]\n");
  });

  it("reports the program's traceback and packages it does not have", async () => {
    const failed = await engine.execute("def frob():\n    raise ValueError('quux-stop')\nfrob()", options, io);
    expect(failed.error).toContain("ValueError: quux-stop");
    expect(failed.error).toContain("in frob");
    expect((await engine.execute("pass", { ...options, packages: ["no-such-plugh"] }, io)).error).toBe('Package "no-such-plugh" is not available here');
  });
});

describe.skipIf(!online)("notebook Matplotlib output", { timeout: 120_000 }, () => {
  let engine: KernelEngine;
  const run = (source: string) => engine.execute(source, { ...options, packages: ["matplotlib"] }, io);

  beforeAll(async () => {
    engine = await createPythonEngine(indexURL);
  }, 60_000);
  beforeEach(async () => {
    const result = await run('globals().clear()\nimport matplotlib.pyplot as plt\nplt.close("all")\nplt.rcdefaults()\nplt.rcParams.update({"figure.figsize": (2, 2), "figure.dpi": 40})');
    if (result.error) throw new Error(result.error);
  }, 120_000);

  it("starts the next cell with fresh axes while retaining Python variables", async () => {
    const first = await run('counter = 17\nplt.plot([0, 1], [0, 1], color="red")');
    expect(first.figures).toHaveLength(1);
    const second = await run('assert plt.get_fignums() == []\ncounter += 1\nplt.plot([0, 1], [1, 0], color="blue")\nprint(counter, len(plt.gca().lines))');
    expect(second.error).toBeUndefined();
    expect(second.stdout).toBe("18 1\n");
    expect(second.figures).toHaveLength(1);
    expect(second.figures![0]).not.toBe(first.figures![0]);
    const unrelated = await run('print(counter, plt.get_fignums())');
    expect(unrelated.stdout).toBe("18 []\n");
    expect(unrelated.figures).toEqual([]);
  });

  it("does not accumulate blank canvases from clf across repeated runs", async () => {
    const source = 'assert plt.get_fignums() == []\nplt.clf()\nfigure, axes = plt.subplots()\naxes.plot([1, 3], [4, 2])';
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await run(source);
      expect(result.error).toBeUndefined();
      expect(result.figures).toHaveLength(1);
    }
    expect((await run('plt.clf()\nplt.show()\nplt.figure()')).figures).toEqual([]);
    expect((await run('print(plt.get_fignums())')).stdout).toBe("[]\n");
  });

  it("displays multiple figures and figure-level text without duplicating them", async () => {
    const result = await run('plt.figure()\nplt.plot([1, 2], [3, 1])\nplt.figure()\nplt.scatter([2, 4], [1, 3])\nplt.figure().text(0.2, 0.5, "blorf")');
    expect(result.error).toBeUndefined();
    expect(result.figures).toHaveLength(3);
    expect(new Set(result.figures).size).toBe(3);
    expect((await run('print(plt.get_fignums())')).stdout).toBe("[]\n");
  });

  it("closes shown figures and captures later plots once at cell completion", async () => {
    const result = await run('plt.plot([0, 1], [0, 1])\nplt.show()\nplt.show()\nassert plt.get_fignums() == []\nplt.plot([0, 1], [1, 0])\nplt.show(block=False)\nplt.plot([0, 1], [0.5, 0.5])');
    expect(result.error).toBeUndefined();
    expect(result.figures).toHaveLength(3);
    expect(new Set(result.figures).size).toBe(3);
  });

  it("preserves plot output on a cell error without leaking its active figure", async () => {
    const failed = await run('plt.plot([0, 1], [0, 1])\nraise ValueError("quux-stop")');
    expect(failed.error).toContain("quux-stop");
    expect(failed.figures).toHaveLength(1);
    const next = await run('assert plt.get_fignums() == []\nplt.plot([0, 1], [1, 0])\nprint(len(plt.gca().lines))');
    expect(next.stdout).toBe("1\n");
    expect(next.figures).toHaveLength(1);
  });

  it("closes figures even when Matplotlib cannot render an artist", async () => {
    const failed = await run(String.raw`plt.figure().text(0.2, 0.5, r"$\quuxcommand$")`);
    expect(failed.exitCode).toBe(1);
    expect(failed.figures).toEqual([]);
    const next = await run('print(plt.get_fignums())\nplt.plot([1, 2], [3, 1])');
    expect(next.stdout).toBe("[]\n");
    expect(next.figures).toHaveLength(1);
  });
});
