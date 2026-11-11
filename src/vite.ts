// @skevo18/vue-ai-component/vite: self-hosts what createCodeTool loads at run time. The run_code workers come from
// this package's dist/code-workers/, Pyodide's core from the host's `pyodide` dependency, and the wheels of the
// chosen packages (with their dependencies) from the Pyodide CDN once, checked against the lockfile's sha256 and
// cached. Both folders carry a content hash in their name, so hosts may cache them forever. The dev server serves
// them, the build emits them, and `import { assetsUrl, pyodideUrl } from "@skevo18/vue-ai-component/code-assets"`
// gives their URLs.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** The content security policy the host serves the run_code workers with (`<dir>/code-<hash>/`). */
export const CODE_WORKER_CSP = "default-src 'none'; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'";

export interface CodeAssetsOptions {
  /** output folder and URL path below the site root, default "assets" */
  dir?: string;
  /** Pyodide packages to host with their dependencies, default numpy, pandas and matplotlib */
  packages?: string[];
  /** where the wheels download from, `{version}` is the Pyodide version */
  cdn?: string;
}

interface LockEntry {
  name: string;
  file_name: string;
  sha256: string;
  depends?: string[];
}

interface Lock {
  packages: Record<string, LockEntry>;
  [key: string]: unknown;
}

interface Hosted {
  /** folder names below `dir` */
  code: string;
  pyodide: string;
  workers: Map<string, Buffer>;
  lock: string;
  wheels: Map<string, LockEntry>;
}

const MODULE = "@skevo18/vue-ai-component/code-assets";
const WORKERS = ["javascript-worker.js", "python-worker.js"];
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"];
const LOCK = "pyodide-lock.json";

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const digest = (...parts: (string | Buffer)[]) => parts.reduce((hash, part) => hash.update(part), createHash("sha256")).digest("hex");

function contentType(file: string): string {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/** The lockfile keys of `names` and everything they depend on. */
function closure(lock: Lock, names: string[]): Set<string> {
  const byName = new Map(Object.entries(lock.packages).map(([key, entry]) => [normalize(entry.name ?? key), key]));
  const keys = new Set<string>();
  const pending = [...names];
  while (pending.length) {
    const name = pending.pop()!;
    const key = byName.get(normalize(name));
    if (!key) throw new Error(`codeAssets: Pyodide has no package ${name}`);
    if (keys.has(key)) continue;
    keys.add(key);
    pending.push(...(lock.packages[key]!.depends ?? []));
  }
  return keys;
}

export function codeAssets(options: CodeAssetsOptions = {}): Plugin {
  const dir = (options.dir ?? "assets").replace(/^\/+|\/+$/g, "");
  // dist/vite.js sits next to dist/code-workers/
  const workerDir = fileURLToPath(new URL(/* @vite-ignore */ "./code-workers/", import.meta.url));
  let pyodide = "";
  let version = "";
  let cache = "";
  let base = "/";
  let hosted: Promise<Hosted> | undefined;

  function load(): Promise<Hosted> {
    hosted ??= (async () => {
      const workers = new Map(await Promise.all(WORKERS.map(async (file) => [file, await readFile(join(workerDir, file))] as const)));
      const lock = JSON.parse(await readFile(join(pyodide, LOCK), "utf8")) as Lock;
      const keys = closure(lock, options.packages ?? ["numpy", "pandas", "matplotlib"]);
      const kept = JSON.stringify({ ...lock, packages: Object.fromEntries(Object.entries(lock.packages).filter(([key]) => keys.has(key))) });
      return {
        code: `code-${digest(...workers.values()).slice(0, 12)}`,
        pyodide: `pyodide-${version}-${digest(kept).slice(0, 8)}`,
        workers,
        lock: kept,
        wheels: new Map([...keys].map((key) => [lock.packages[key]!.file_name, lock.packages[key]!])),
      };
    })();
    return hosted;
  }

  /** A wheel from the cache, downloaded and checked first when missing. */
  async function wheel(entry: LockEntry): Promise<Buffer> {
    const path = join(cache, entry.file_name);
    const cached = await readFile(path).catch(() => null);
    if (cached && digest(cached) === entry.sha256) return cached;
    const url = (options.cdn ?? "https://cdn.jsdelivr.net/pyodide/v{version}/full/").replace("{version}", version) + encodeURIComponent(entry.file_name);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`codeAssets: ${url} answered ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (digest(data) !== entry.sha256) throw new Error(`codeAssets: ${entry.file_name} does not match its sha256`);
    await mkdir(cache, { recursive: true });
    await writeFile(`${path}.part`, data);
    await rename(`${path}.part`, path);
    return data;
  }

  /** The bytes of `/<dir>/<folder>/<file>`, or null when it is not hosted. */
  async function asset(folder: string, file: string): Promise<Buffer | string | null> {
    const host = await load();
    if (folder === host.code) return host.workers.get(file) ?? null;
    if (folder !== host.pyodide) return null;
    if (CORE.includes(file)) return readFile(join(pyodide, file));
    if (file === LOCK) return host.lock;
    const entry = host.wheels.get(file);
    return entry ? wheel(entry) : null;
  }

  return {
    name: "vue-ai-component-code-assets",
    enforce: "pre",
    configResolved(config) {
      base = config.base;
      const require = createRequire(join(config.root, "package.json"));
      let manifest: string;
      try {
        manifest = require.resolve("pyodide/package.json");
      } catch {
        throw new Error("codeAssets needs the pyodide package: bun add pyodide");
      }
      pyodide = dirname(manifest);
      const meta: unknown = require(manifest);
      if (!meta || typeof meta !== "object" || !("version" in meta) || typeof meta.version !== "string") throw new Error("codeAssets: the pyodide package has no version");
      version = meta.version;
      cache = join(config.cacheDir, "vue-ai-component", `pyodide-${version}`);
    },
    resolveId(id) {
      if (id === MODULE) return "\0" + MODULE;
    },
    async load(id) {
      if (id !== "\0" + MODULE) return;
      const host = await load();
      return `export const assetsUrl = ${JSON.stringify(`${base}${dir}/${host.code}/`)};\nexport const pyodideUrl = ${JSON.stringify(`${base}${dir}/${host.pyodide}/`)};\n`;
    },
    configureServer(server) {
      server.middlewares.use(`/${dir}`, async (request, response, next) => {
        const [folder = "", file = "", ...rest] = (request.url ?? "").split("?")[0]!.split("/").filter(Boolean);
        if (rest.length || !/^(code|pyodide)-/.test(folder)) return next();
        try {
          const body = await asset(folder, file);
          if (body === null) return next();
          response.setHeader("Content-Type", contentType(file));
          if (folder.startsWith("code-")) response.setHeader("Content-Security-Policy", CODE_WORKER_CSP);
          response.end(body);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      const host = await load();
      for (const [file, source] of host.workers) this.emitFile({ type: "asset", fileName: `${dir}/${host.code}/${file}`, source });
      for (const file of CORE) this.emitFile({ type: "asset", fileName: `${dir}/${host.pyodide}/${file}`, source: await readFile(join(pyodide, file)) });
      this.emitFile({ type: "asset", fileName: `${dir}/${host.pyodide}/${LOCK}`, source: host.lock });
      for (const entry of host.wheels.values()) this.emitFile({ type: "asset", fileName: `${dir}/${host.pyodide}/${entry.file_name}`, source: await wheel(entry) });
    },
  };
}
