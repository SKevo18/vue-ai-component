// src/code/worker/classic-script.ts
var native = globalThis.importScripts;
var importScript = typeof native === "function" ? native.bind(globalThis) : void 0;
var createURL = URL.createObjectURL.bind(URL);
var revokeURL = URL.revokeObjectURL.bind(URL);
var ScriptBlob = Blob;
function runGlobalScript(source) {
	if (!importScript) throw new Error("JavaScript runs only in a classic worker");
	const url = createURL(new ScriptBlob([source], { type: "text/javascript" }));
	try {
		importScript(url);
	} finally {
		revokeURL(url);
	}
}
// src/code/worker/serve.ts
/**
* Answers the kernel client's requests one at a time. The engine and its file system stay alive between requests;
* only per-command I/O is replaced. `create` gets the first request, with any fields the host's transport added.
*/
function serveKernel(create) {
	const post = self.postMessage.bind(self);
	let engine;
	let queue = Promise.resolve();
	let lastId = 0;
	const send = (response) => post(response);
	self.onmessage = (event) => {
		const request = event.data;
		if (!Number.isSafeInteger(request?.id) || request.id <= lastId) return;
		lastId = request.id;
		queue = queue.then(async () => {
			const id = request.id;
			try {
				engine ??= Promise.resolve().then(() => create(request));
				let instance;
				try {
					instance = await engine;
				} catch (error) {
					send({
						id,
						type: "error",
						error: error instanceof Error ? error.message : String(error),
						fatal: true
					});
					return;
				}
				const io = {
					status: (status) => send({
						id,
						type: "status",
						status
					}),
					input: (message) => send({
						...message,
						id
					})
				};
				let value;
				switch (request.op) {
					case "execute":
						value = await instance.execute(request.source, request.options, io);
						break;
					case "listFiles":
						value = await instance.listFiles();
						break;
					case "readFile":
						value = await instance.readFile(request.name);
						break;
					case "writeFile":
						value = await instance.writeFile(request.name, request.data);
						break;
					case "removeFile": value = await instance.removeFile(request.name);
				}
				send({
					id,
					type: "result",
					value
				});
			} catch (error) {
				send({
					id,
					type: "error",
					error: error instanceof Error ? error.message : String(error)
				});
			}
		});
	};
}
// src/code/worker/harden.ts
var BLOCKED = [
	"XMLHttpRequest",
	"WebSocket",
	"WebSocketStream",
	"EventSource",
	"BroadcastChannel",
	"Worker",
	"SharedWorker",
	"WebTransport",
	"RTCPeerConnection",
	"caches",
	"fetchLater"
];
/**
* Whether a worker may fetch `raw` (resolved against `base`, the worker's own URL): same origin, a path under one of
* `prefixes`. Encoded slashes, backslashes and dots are refused: proxies decode and normalise them before routing.
*/
function allowedUrl(raw, base, prefixes) {
	let url;
	try {
		url = new URL(raw, base);
	} catch {
		return false;
	}
	if (url.origin !== new URL(base).origin || url.username || url.password) return false;
	if (/%2f|%5c|%2e|\\/i.test(url.pathname)) return false;
	return prefixes.some((prefix) => url.pathname.startsWith(prefix));
}
/** Replaces `name` on the global object and every prototype that defines it, so no original stays reachable. */
function replace(name, value) {
	for (let o = self; o; o = Object.getPrototypeOf(o)) if (Object.hasOwn(o, name)) Object.defineProperty(o, name, {
		value,
		writable: false,
		configurable: false,
		enumerable: false
	});
}
/** Confines this worker's network to same-origin `prefixes` (path prefixes such as "/assets/pyodide/"). */
function hardenWorker(prefixes) {
	const base = self.location.href;
	const nativeFetch = self.fetch.bind(self);
	const nativeImportScripts = "importScripts" in self ? self.importScripts : void 0;
	const blocked = (url) => /* @__PURE__ */ new TypeError(`Network access is not allowed: ${url}`);
	replace("fetch", (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!allowedUrl(url, base, prefixes)) return Promise.reject(blocked(url));
		return nativeFetch(new Request(input, {
			...init,
			credentials: "omit"
		}));
	});
	if (nativeImportScripts) replace("importScripts", (...urls) => {
		for (const url of urls) if (!allowedUrl(url, base, prefixes)) throw blocked(url);
		if (typeof nativeImportScripts === "function") nativeImportScripts.apply(self, urls);
	});
	for (const name of BLOCKED) replace(name, void 0);
}
// src/code/worker/native-fs.ts
var S_IFMT = 61440;
var S_IFDIR = 16384;
var S_IFREG = 32768;
/** A workspace file name: relative, `/` separated, without empty, `.` or `..` parts. */
function fileName(name) {
	const path = name.startsWith("/") ? name.slice(1) : name;
	if (!path || path.includes("\0") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Invalid file path: ${name}`);
	return path;
}
/** The regular files under `root` as a kernel's file API; writing creates missing folders. */
function nativeFiles(fs, root) {
	const base = root === "/" ? "" : root.replace(/\/$/, "");
	function path(name, parents = false) {
		const parts = fileName(name).split("/");
		let dir = base;
		for (const part of parts.slice(0, -1)) {
			dir += "/" + part;
			let stat;
			try {
				stat = fs.lstat(dir);
			} catch (error) {
				if (!parents) throw error;
				fs.mkdir(dir);
				stat = fs.lstat(dir);
			}
			if ((stat.mode & S_IFMT) !== S_IFDIR) throw new Error(`Not a directory: ${dir}`);
		}
		const target = dir + "/" + parts[parts.length - 1];
		let stat;
		try {
			stat = fs.lstat(target);
		} catch {
			return target;
		}
		if ((stat.mode & S_IFMT) !== S_IFREG) throw new Error(`Not a regular file: ${name}`);
		return target;
	}
	return {
		listFiles() {
			const files = [];
			const pending = [{
				path: base || "/",
				prefix: ""
			}];
			while (pending.length) {
				const dir = pending.pop();
				for (const entry of fs.readdir(dir.path)) {
					if (entry === "." || entry === "..") continue;
					const target = `${dir.path.replace(/\/$/, "")}/${entry}`;
					const name = dir.prefix + entry;
					const stat = fs.lstat(target);
					if ((stat.mode & S_IFMT) === S_IFDIR) pending.push({
						path: target,
						prefix: name + "/"
					});
					else if ((stat.mode & S_IFMT) === S_IFREG) files.push({
						name,
						size: stat.size
					});
				}
			}
			return files.sort((a, b) => a.name.localeCompare(b.name));
		},
		readFile: (name) => fs.readFile(path(name)),
		writeFile: (name, data) => fs.writeFile(path(name, true), data),
		removeFile: (name) => fs.unlink(path(name))
	};
}
// src/code/worker/javascript-fs.ts
/** A private byte store shared by the kernel explorer and JavaScript's fs/CommonJS APIs. */
var JavaScriptFiles = class {
	files = /* @__PURE__ */ new Map();
	cache = /* @__PURE__ */ new Map();
	encoder = new TextEncoder();
	decoder = new TextDecoder();
	path(name) {
		if (typeof name !== "string" || name.includes("\0") || name.includes("\\")) throw new Error("Invalid file path");
		const parts = [];
		for (const part of name.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") {
				if (!parts.length) throw new Error("File path leaves the working directory");
				parts.pop();
			} else parts.push(part);
		}
		return parts.join("/");
	}
	listFiles() {
		return [...this.files].map(([name, data]) => ({
			name,
			size: data.byteLength
		})).sort((a, b) => a.name.localeCompare(b.name));
	}
	readFile(name) {
		const key = this.path(name);
		const data = this.files.get(key);
		if (!data) throw new Error(`ENOENT: no such file, '${name}'`);
		return data.slice();
	}
	readText(name) {
		return this.decoder.decode(this.readFile(name));
	}
	writeFile(name, data) {
		const key = this.path(name);
		if (!key) throw new Error("A file name is required");
		for (const existing of this.files.keys()) if (existing.startsWith(key + "/") || key.startsWith(existing + "/")) throw new Error(`File and directory conflict: '${name}'`);
		this.files.set(key, data.slice());
	}
	removeFile(name) {
		if (!this.files.delete(this.path(name))) throw new Error(`ENOENT: no such file, '${name}'`);
	}
	/** Text projection for assignment test contexts, never used to restore interpreter storage. */
	textFiles() {
		return Object.fromEntries([...this.files].map(([name, data]) => [name, this.decoder.decode(data)]));
	}
	installCommonJS(target) {
		const encodingName = (encoding) => {
			const value = typeof encoding === "object" ? encoding?.encoding : encoding;
			if (value && value !== "utf8" && value !== "utf-8") throw new Error(`Unsupported encoding '${value}'`);
			return value;
		};
		const fs = {
			readFileSync: (name, encoding) => encodingName(encoding) ? this.readText(name) : this.readFile(name),
			writeFileSync: (name, data, encoding) => {
				encodingName(encoding);
				this.writeFile(name, typeof data === "string" ? this.encoder.encode(data) : data);
			},
			appendFileSync: (name, data, encoding) => {
				encodingName(encoding);
				const old = this.files.get(this.path(name));
				const addition = typeof data === "string" ? this.encoder.encode(data) : data;
				const joined = new Uint8Array((old?.byteLength ?? 0) + addition.byteLength);
				if (old) joined.set(old);
				joined.set(addition, old?.byteLength ?? 0);
				this.writeFile(name, joined);
			},
			unlinkSync: (name) => this.removeFile(name),
			existsSync: (name) => {
				const key = this.path(name);
				return !key || this.files.has(key) || [...this.files.keys()].some((path) => path.startsWith(key + "/"));
			},
			readdirSync: (name = ".") => {
				const key = this.path(name);
				if (this.files.has(key)) throw new Error(`ENOTDIR: not a directory, '${name}'`);
				const prefix = key ? key + "/" : "";
				const names = [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]);
				if (key && !names.length) throw new Error(`ENOENT: no such directory, '${name}'`);
				return [...new Set(names)].sort();
			}
		};
		const requireFrom = (name, directory) => {
			if (name === "fs" || name === "node:fs") return fs;
			const path = this.path(name.startsWith(".") ? directory + name : name);
			const key = [
				path,
				`${path}.js`,
				`${path}.mjs`,
				`${path}.json`,
				`${path}/index.js`
			].find((candidate) => this.files.has(candidate));
			if (!key) throw new Error(`Cannot find module '${name}'`);
			const previous = this.cache.get(key);
			if (previous) return previous.exports;
			const module = { exports: {} };
			this.cache.set(key, module);
			try {
				if (key.endsWith(".json")) module.exports = JSON.parse(this.readText(key));
				else {
					const dirname = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
					new Function("require", "module", "exports", "__filename", "__dirname", this.readText(key))((name) => requireFrom(name, dirname), module, module.exports, key, dirname.replace(/\/$/, "") || ".");
				}
			} catch (error) {
				this.cache.delete(key);
				throw error;
			}
			return module.exports;
		};
		const module = { exports: {} };
		Object.assign(target, {
			fs,
			require: (name) => requireFrom(name, ""),
			module,
			exports: module.exports
		});
	}
};
// src/code/worker/input.ts
/** The pre-filled input of a run, one line per read, then end of input. */
function prefilledInput(text, output) {
	let pos = 0;
	const source = {
		inputs: [],
		unavailable: false,
		readLine() {
			if (pos >= text.length) {
				source.unavailable = true;
				return null;
			}
			const newline = text.indexOf("\n", pos);
			const end = newline < 0 ? text.length : newline;
			const line = text.slice(pos, end).replace(/\r$/, "");
			pos = end + 1;
			source.inputs.push({
				at: output().stdout.length,
				text: line
			});
			return line;
		}
	};
	return source;
}
// src/code/worker/javascript.ts
var LIMIT = 65536;
function errorText(error) {
	return error instanceof Error ? error.stack || String(error) : String(error);
}
/** Installs the kernel's globals on this worker and returns its engine; call it once per worker. */
function createJavaScriptEngine(hooks = {}) {
	const out = {
		stdout: "",
		stderr: ""
	};
	let error;
	let active = false;
	const files = new JavaScriptFiles();
	files.installCommonJS(self);
	function write(stream, args) {
		if (!active || out[stream].length > LIMIT) return;
		const line = args.map((value) => {
			if (typeof value === "string") return value;
			if (value instanceof Error) return value.stack || String(value);
			if ([
				"function",
				"symbol",
				"bigint"
			].includes(typeof value)) return String(value);
			try {
				return JSON.stringify(value) ?? String(value);
			} catch {
				return String(value);
			}
		}).join(" ");
		out[stream] += line + "\n";
	}
	self.console.log = self.console.info = self.console.debug = (...args) => write("stdout", args);
	self.console.warn = self.console.error = (...args) => write("stderr", args);
	self.addEventListener("error", (event) => {
		if (active) error ??= event.error ? errorText(event.error) : event.message;
		event.preventDefault();
	});
	self.addEventListener("unhandledrejection", (event) => {
		if (active) error ??= errorText(event.reason);
		event.preventDefault();
	});
	const pending = /* @__PURE__ */ new Set();
	const nativeSetTimeout = self.setTimeout.bind(self);
	const nativeClearTimeout = self.clearTimeout.bind(self);
	const nativeSetInterval = self.setInterval.bind(self);
	const nativeClearInterval = self.clearInterval.bind(self);
	Object.assign(self, {
		setTimeout(handler, ms, ...args) {
			const id = nativeSetTimeout(() => {
				pending.delete(id);
				if (typeof handler === "function") handler(...args);
				else runGlobalScript(handler);
			}, ms);
			pending.add(id);
			return id;
		},
		clearTimeout(id) {
			if (id !== void 0) pending.delete(id);
			nativeClearTimeout(id);
		},
		setInterval(handler, ms, ...args) {
			const id = nativeSetInterval(() => {
				if (typeof handler === "function") handler(...args);
				else runGlobalScript(handler);
			}, ms);
			pending.add(id);
			return id;
		},
		clearInterval(id) {
			if (id !== void 0) pending.delete(id);
			nativeClearInterval(id);
		}
	});
	return {
		async execute(source, options, io) {
			out.stdout = "";
			out.stderr = "";
			error = void 0;
			active = true;
			const output = () => out;
			const stdin = hooks.input ? hooks.input(options, output, io) : prefilledInput(options.stdin, output);
			Object.assign(self, { prompt(message) {
				if (message !== void 0 && out.stdout.length <= LIMIT) out.stdout += String(message);
				return stdin.readLine();
			} });
			io.status("running");
			try {
				runGlobalScript(source);
			} catch (cause) {
				error ??= errorText(cause);
			}
			do {
				const settled = Promise.withResolvers();
				nativeSetTimeout(settled.resolve, pending.size ? 10 : 0);
				await settled.promise;
			} while (pending.size);
			const extra = await hooks.finish?.(options, {
				files,
				stdout: out.stdout,
				stderr: out.stderr,
				error
			}) ?? {};
			active = false;
			return {
				stdout: out.stdout,
				stderr: out.stderr,
				error,
				exitCode: error === void 0 ? 0 : 1,
				duration_ms: 0,
				inputUnavailable: stdin.unavailable,
				inputs: stdin.inputs,
				...extra
			};
		},
		listFiles: () => files.listFiles(),
		readFile: (name) => files.readFile(name),
		writeFile: (name, data) => files.writeFile(name, data),
		removeFile: (name) => files.removeFile(name)
	};
}
// src/code/worker/python.ts
var PYTHON_HOME = "/home/pyodide";
/** PEP 503 normalised project name. */
function normalizeName(name) {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}
/** The lookup of a parsed `pyodide-lock.json`. */
function lockIndex(lock) {
	const out = {};
	for (const [key, entry] of Object.entries(lock.packages ?? {})) out[normalizeName(entry.name ?? key)] = {
		key,
		depends: entry.depends ?? []
	};
	return out;
}
/** Loads Pyodide from `indexURL` (a folder URL ending in `/`); each caller owns the interpreter. */
async function loadPython(indexURL) {
	const py = await (await import(
		/* @vite-ignore */
		`${indexURL}pyodide.mjs`
)).loadPyodide({ indexURL });
	return {
		py,
		lock: lockIndex(py.lockfile)
	};
}
/** Loads the named packages of the Pyodide distribution; an error message names the ones it does not have. */
async function installFromLock(py, lock, names) {
	if (!names.length) return void 0;
	const missing = names.filter((name) => !lock[normalizeName(name)]);
	if (missing.length) return missing.map((name) => `Package "${name}" is not available here`).join("\n");
	const errors = [];
	await py.loadPackage(names.map((name) => lock[normalizeName(name)].key), {
		messageCallback: () => void 0,
		errorCallback: (message) => errors.push(message)
	});
	return errors.length ? errors.join("\n") : void 0;
}
var NOTEBOOK = `
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
/** Retains the interpreter, its module registry, user namespace and files under PYTHON_HOME. */
async function createPythonEngine(indexURL, hooks = {}) {
	const { py, lock } = await loadPython(indexURL);
	py.runPython(`import types as _code_types\n_code_notebook = _code_types.ModuleType("_code_notebook")\nexec(${JSON.stringify(NOTEBOOK)}, _code_notebook.__dict__)`);
	const files = nativeFiles(py.FS, PYTHON_HOME);
	let output = {
		stdout: "",
		stderr: ""
	};
	return {
		...files,
		async execute(source, options, io) {
			output = {
				stdout: "",
				stderr: ""
			};
			const decoders = {
				stdout: new TextDecoder(),
				stderr: new TextDecoder()
			};
			for (const stream of ["stdout", "stderr"]) {
				const sink = { write: (bytes) => {
					if (output[stream].length <= 65536) output[stream] += decoders[stream].decode(bytes, { stream: true });
					return bytes.byteLength;
				} };
				if (stream === "stdout") py.setStdout(sink);
				else py.setStderr(sink);
			}
			try {
				const requested = [.../* @__PURE__ */ new Set([...options.packages, ...hooks.packages?.(files, options) ?? []])];
				const failed = hooks.install ? await hooks.install(py, lock, requested, options) : await installFromLock(py, lock, requested);
				if (failed) return {
					stdout: "",
					stderr: "",
					error: failed,
					exitCode: 1,
					duration_ms: 0
				};
				if (hooks.importedPackages) {
					const errors = [];
					await py.loadPackagesFromImports(source, {
						messageCallback: () => void 0,
						errorCallback: (message) => errors.push(message)
					});
					if (errors.length) return {
						stdout: "",
						stderr: "",
						error: errors.join("\n"),
						exitCode: 1,
						duration_ms: 0
					};
				}
			} catch (reason) {
				return {
					...output,
					error: reason instanceof Error ? reason.message : String(reason),
					exitCode: 1,
					duration_ms: 0
				};
			}
			const getOutput = () => output;
			const stdin = hooks.input ? hooks.input(options, getOutput, io) : prefilledInput(options.stdin, getOutput);
			py.setStdin({ stdin: () => {
				const line = stdin.readLine();
				return line === null ? null : line + "\n";
			} });
			io.status("running");
			let result;
			try {
				result = JSON.parse(String(await py.runPythonAsync(`await _code_notebook.run(${JSON.stringify(source)})`)));
			} catch (reason) {
				result = {
					error: reason instanceof Error ? reason.message : String(reason),
					exitCode: 1,
					figures: []
				};
			}
			for (const stream of ["stdout", "stderr"]) if (output[stream].length <= 65536) output[stream] += decoders[stream].decode();
			return {
				...output,
				...result,
				error: result.error ?? void 0,
				inputs: stdin.inputs,
				inputUnavailable: stdin.unavailable,
				duration_ms: 0
			};
		}
	};
}
export { JavaScriptFiles, PYTHON_HOME, allowedUrl, createJavaScriptEngine, createPythonEngine, errorText, fileName, hardenWorker, installFromLock, loadPython, lockIndex, nativeFiles, normalizeName, prefilledInput, runGlobalScript, serveKernel };
