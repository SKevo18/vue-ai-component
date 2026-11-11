// The Python kernel inside a module worker: Pyodide from a self-hosted folder, one interpreter that keeps its
// modules, variables and files between runs, matplotlib figures captured as PNG, top-level await.
import type { KernelEngine, KernelExecution, RunResult } from "../types";
import { prefilledInput, type InputFactory } from "./input";
import { nativeFiles, type NativeFiles, type NativeFs } from "./native-fs";

export const PYTHON_HOME = "/home/pyodide";

export interface PythonFs extends NativeFs {
  rmdir(path: string): void;
}

export interface PackageLoader {
  loadPackage(names: string[], options: { messageCallback: (message: string) => void; errorCallback: (message: string) => void }): Promise<unknown>;
  runPythonAsync(code: string): Promise<unknown>;
}

export interface Pyodide extends PackageLoader {
  FS: PythonFs;
  globals: { get(name: string): unknown };
  runPython(code: string): unknown;
  /** the lockfile Pyodide loaded with */
  readonly lockfile: { packages?: Record<string, { name?: string; depends?: string[] }> };
  loadPackagesFromImports(code: string, options: { messageCallback: (message: string) => void; errorCallback: (message: string) => void }): Promise<unknown>;
  setStdout(options: { write: (bytes: Uint8Array) => number; isatty?: boolean }): void;
  setStderr(options: { write: (bytes: Uint8Array) => number; isatty?: boolean }): void;
  setStdin(options: { stdin: () => string | null }): void;
}

/** Pyodide lockfile entries by normalised name: the lockfile's own key and its dependencies. */
export type LockIndex = Record<string, { key: string; depends: string[] }>;

/** PEP 503 normalised project name. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The lookup of a parsed `pyodide-lock.json`. */
export function lockIndex(lock: { packages?: Record<string, { name?: string; depends?: string[] }> }): LockIndex {
  const out: LockIndex = {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) out[normalizeName(entry.name ?? key)] = { key, depends: entry.depends ?? [] };
  return out;
}

/** Loads Pyodide from `indexURL` (a folder URL ending in `/`); each caller owns the interpreter. */
export async function loadPython(indexURL: string): Promise<{ py: Pyodide; lock: LockIndex }> {
  // the host serves Pyodide at a runtime URL; it is never part of this bundle
  const module = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as { loadPyodide(options: { indexURL: string }): Promise<Pyodide> };
  const py = await module.loadPyodide({ indexURL });
  return { py, lock: lockIndex(py.lockfile) };
}

/** Loads the named packages of the Pyodide distribution; an error message names the ones it does not have. */
export async function installFromLock(py: PackageLoader, lock: LockIndex, names: string[]): Promise<string | undefined> {
  if (!names.length) return undefined;
  const missing = names.filter((name) => !lock[normalizeName(name)]);
  if (missing.length) return missing.map((name) => `Package "${name}" is not available here`).join("\n");
  const errors: string[] = [];
  await py.loadPackage(names.map((name) => lock[normalizeName(name)]!.key), { messageCallback: () => undefined, errorCallback: (message) => errors.push(message) });
  return errors.length ? errors.join("\n") : undefined;
}

const NOTEBOOK = `
import ast, base64, builtins, inspect, io, json, os, sys, traceback, types, warnings
os.environ["MPLBACKEND"] = "Agg"
warnings.filterwarnings("ignore", message=r"The [xy] parameter as float was deprecated")
os.chdir("${PYTHON_HOME}")
if "${PYTHON_HOME}" not in sys.path:
    sys.path.insert(0, "${PYTHON_HOME}")
main = types.ModuleType("__main__")
main.__dict__["__builtins__"] = builtins
sys.modules["__main__"] = main
terminal = sys.stdin, sys.stdout, sys.stderr
figures = []

def capture():
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    from matplotlib._pylab_helpers import Gcf
    try:
        for manager in Gcf.get_all_fig_managers():
            if len(figures) >= 20:
                break
            figure = manager.canvas.figure
            # clf() can create a bare canvas before the program creates its actual figure.
            if not any(child is not figure.patch and child.get_visible() for child in figure.get_children()):
                continue
            image = io.BytesIO()
            figure.savefig(image, format="png", bbox_inches="tight")
            figures.append(base64.b64encode(image.getvalue()).decode("ascii"))
    finally:
        pyplot.close("all")

def show(*args, **kwargs):
    capture()

def trace(error):
    tb = error.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != "${PYTHON_HOME}/<cell>":
        tb = tb.tb_next
    return "".join(traceback.format_exception(type(error), error, tb)).rstrip()

async def run(source):
    figures.clear()
    sys.stdin, sys.stdout, sys.stderr = terminal
    if __import__("importlib.util", fromlist=["find_spec"]).find_spec("matplotlib") is not None:
        import matplotlib.pyplot as pyplot
        pyplot.show = show
    error, exit_code = None, 0
    try:
        code = compile(source, "${PYTHON_HOME}/<cell>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        result = eval(code, main.__dict__)
        if inspect.isawaitable(result):
            await result
    except SystemExit as reason:
        if reason.code not in (None, 0):
            error = "SystemExit: %s" % (reason.code,)
            exit_code = reason.code if isinstance(reason.code, int) else 1
    except BaseException as reason:
        error, exit_code = trace(reason), 1
    try:
        capture()
    except Exception as reason:
        error, exit_code = error or trace(reason), 1
    terminal[1].flush()
    terminal[2].flush()
    return json.dumps({"error": error, "exitCode": exit_code, "figures": list(figures)})
`;

export interface PythonEngineOptions<E extends KernelExecution> {
  /** interactive input; the default reads the run's pre-filled stdin */
  input?: InputFactory<E>;
  /** loads the run's packages and returns an error message; the default takes them from the Pyodide distribution */
  install?(py: Pyodide, lock: LockIndex, names: string[], options: E): Promise<string | undefined>;
  /** packages the workspace itself asks for, such as a requirements.txt */
  packages?(files: NativeFiles, options: E): string[];
  /** also loads the distribution packages the program imports (Pyodide's loadPackagesFromImports) */
  importedPackages?: boolean;
}

interface PythonOutcome {
  error: string | null;
  exitCode: number;
  figures: string[];
}

/** Retains the interpreter, its module registry, user namespace and files under PYTHON_HOME. */
export async function createPythonEngine<E extends KernelExecution = KernelExecution, R extends RunResult = RunResult>(indexURL: string, hooks: PythonEngineOptions<E> = {}): Promise<KernelEngine<E, R>> {
  const { py, lock } = await loadPython(indexURL);
  // the private helper namespace cannot be overwritten by a run's globals
  py.runPython(`import types as _code_types\n_code_notebook = _code_types.ModuleType("_code_notebook")\nexec(${JSON.stringify(NOTEBOOK)}, _code_notebook.__dict__)`);
  const files = nativeFiles(py.FS, PYTHON_HOME);
  let output = { stdout: "", stderr: "" };
  return {
    ...files,
    async execute(source, options, io) {
      output = { stdout: "", stderr: "" };
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      for (const stream of ["stdout", "stderr"] as const) {
        const sink = {
          write: (bytes: Uint8Array) => {
            if (output[stream].length <= 65536) output[stream] += decoders[stream].decode(bytes, { stream: true });
            return bytes.byteLength;
          },
        };
        if (stream === "stdout") py.setStdout(sink);
        else py.setStderr(sink);
      }
      try {
        const requested = [...new Set([...options.packages, ...(hooks.packages?.(files, options) ?? [])])];
        const failed = hooks.install ? await hooks.install(py, lock, requested, options) : await installFromLock(py, lock, requested);
        if (failed) return { stdout: "", stderr: "", error: failed, exitCode: 1, duration_ms: 0 } as R;
        if (hooks.importedPackages) {
          const errors: string[] = [];
          await py.loadPackagesFromImports(source, { messageCallback: () => undefined, errorCallback: (message) => errors.push(message) });
          if (errors.length) return { stdout: "", stderr: "", error: errors.join("\n"), exitCode: 1, duration_ms: 0 } as R;
        }
      } catch (reason) {
        return { ...output, error: reason instanceof Error ? reason.message : String(reason), exitCode: 1, duration_ms: 0 } as R;
      }
      const getOutput = () => output;
      const stdin = hooks.input ? hooks.input(options, getOutput, io) : prefilledInput(options.stdin, getOutput);
      py.setStdin({
        stdin: () => {
          const line = stdin.readLine();
          return line === null ? null : line + "\n";
        },
      });
      io.status("running");
      let result: PythonOutcome;
      try {
        result = JSON.parse(String(await py.runPythonAsync(`await _code_notebook.run(${JSON.stringify(source)})`))) as PythonOutcome;
      } catch (reason) {
        result = { error: reason instanceof Error ? reason.message : String(reason), exitCode: 1, figures: [] };
      }
      for (const stream of ["stdout", "stderr"] as const) if (output[stream].length <= 65536) output[stream] += decoders[stream].decode();
      return { ...output, ...result, error: result.error ?? undefined, inputs: stdin.inputs, inputUnavailable: stdin.unavailable, duration_ms: 0 } as R;
    },
  };
}
