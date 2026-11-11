// src/code/worker/harden.ts
var e = [
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
function t(e, t, n) {
	let r;
	try {
		r = new URL(e, t);
	} catch {
		return !1;
	}
	return r.origin !== new URL(t).origin || r.username || r.password || /%2f|%5c|%2e|\\/i.test(r.pathname) ? !1 : n.some((e) => r.pathname.startsWith(e));
}
function n(e, t) {
	for (let n = self; n; n = Object.getPrototypeOf(n)) Object.hasOwn(n, e) && Object.defineProperty(n, e, {
		value: t,
		writable: !1,
		configurable: !1,
		enumerable: !1
	});
}
function r(r) {
	let i = self.location.href, a = self.fetch.bind(self), o = "importScripts" in self ? self.importScripts : void 0, s = (e) => /* @__PURE__ */ TypeError(`Network access is not allowed: ${e}`);
	n("fetch", (e, n) => {
		let o = e instanceof Request ? e.url : String(e);
		return t(o, i, r) ? a(new Request(e, {
			...n,
			credentials: "omit"
		})) : Promise.reject(s(o));
	}), o && n("importScripts", (...e) => {
		for (let n of e) if (!t(n, i, r)) throw s(n);
		typeof o == "function" && o.apply(self, e);
	});
	for (let t of e) n(t, void 0);
}
// src/code/worker/input.ts
function i(e, t) {
	let n = 0, r = {
		inputs: [],
		unavailable: !1,
		readLine() {
			if (n >= e.length) return r.unavailable = !0, null;
			let i = e.indexOf("\n", n), a = i < 0 ? e.length : i, o = e.slice(n, a).replace(/\r$/, "");
			return n = a + 1, r.inputs.push({
				at: t().stdout.length,
				text: o
			}), o;
		}
	};
	return r;
}
// src/code/worker/native-fs.ts
var a = 61440, o = 16384, s = 32768;
function c(e) {
	let t = e.startsWith("/") ? e.slice(1) : e;
	if (!t || t.includes("\0") || t.includes("\\") || t.split("/").some((e) => !e || e === "." || e === "..")) throw Error(`Invalid file path: ${e}`);
	return t;
}
function l(e, t) {
	let n = t === "/" ? "" : t.replace(/\/$/, "");
	function r(t, r = !1) {
		let i = c(t).split("/"), l = n;
		for (let t of i.slice(0, -1)) {
			l += "/" + t;
			let n;
			try {
				n = e.lstat(l);
			} catch (t) {
				if (!r) throw t;
				e.mkdir(l), n = e.lstat(l);
			}
			if ((n.mode & a) !== o) throw Error(`Not a directory: ${l}`);
		}
		let u = l + "/" + i[i.length - 1], d;
		try {
			d = e.lstat(u);
		} catch {
			return u;
		}
		if ((d.mode & a) !== s) throw Error(`Not a regular file: ${t}`);
		return u;
	}
	return {
		listFiles() {
			let t = [], r = [{
				path: n || "/",
				prefix: ""
			}];
			for (; r.length;) {
				let n = r.pop();
				for (let i of e.readdir(n.path)) {
					if (i === "." || i === "..") continue;
					let c = `${n.path.replace(/\/$/, "")}/${i}`, l = n.prefix + i, u = e.lstat(c);
					(u.mode & a) === o ? r.push({
						path: c,
						prefix: l + "/"
					}) : (u.mode & a) === s && t.push({
						name: l,
						size: u.size
					});
				}
			}
			return t.sort((e, t) => e.name.localeCompare(t.name));
		},
		readFile: (t) => e.readFile(r(t)),
		writeFile: (t, n) => e.writeFile(r(t, !0), n),
		removeFile: (t) => e.unlink(r(t))
	};
}
// src/code/worker/python.ts
var u = "/home/pyodide";
function d(e) {
	return e.toLowerCase().replace(/[-_.]+/g, "-");
}
function f(e) {
	let t = {};
	for (let [n, r] of Object.entries(e.packages ?? {})) t[d(r.name ?? n)] = {
		key: n,
		depends: r.depends ?? []
	};
	return t;
}
async function p(e) {
	let t = await (await import(
		/* @vite-ignore */
		`${e}pyodide.mjs`
)).loadPyodide({ indexURL: e });
	return {
		py: t,
		lock: f(t.lockfile)
	};
}
async function m(e, t, n) {
	if (!n.length) return;
	let r = n.filter((e) => !t[d(e)]);
	if (r.length) return r.map((e) => `Package "${e}" is not available here`).join("\n");
	let i = [];
	return await e.loadPackage(n.map((e) => t[d(e)].key), {
		messageCallback: () => void 0,
		errorCallback: (e) => i.push(e)
	}), i.length ? i.join("\n") : void 0;
}
var h = `
import ast, base64, builtins, inspect, io, json, os, sys, traceback, types, warnings
os.environ["MPLBACKEND"] = "Agg"
warnings.filterwarnings("ignore", message=r"The [xy] parameter as float was deprecated")
os.chdir("${u}")
if "${u}" not in sys.path:
    sys.path.insert(0, "${u}")
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
    while tb is not None and tb.tb_frame.f_code.co_filename != "${u}/<cell>":
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
        code = compile(source, "${u}/<cell>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
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
async function g(e, t = {}) {
	let { py: n, lock: r } = await p(e);
	n.runPython(`import types as _code_types\n_code_notebook = _code_types.ModuleType("_code_notebook")\nexec(${JSON.stringify(h)}, _code_notebook.__dict__)`);
	let a = l(n.FS, u), o = {
		stdout: "",
		stderr: ""
	};
	return {
		...a,
		async execute(e, s, c) {
			o = {
				stdout: "",
				stderr: ""
			};
			let l = {
				stdout: new TextDecoder(),
				stderr: new TextDecoder()
			};
			for (let e of ["stdout", "stderr"]) {
				let t = { write: (t) => (o[e].length <= 65536 && (o[e] += l[e].decode(t, { stream: !0 })), t.byteLength) };
				e === "stdout" ? n.setStdout(t) : n.setStderr(t);
			}
			try {
				let i = [.../* @__PURE__ */ new Set([...s.packages, ...t.packages?.(a, s) ?? []])], o = t.install ? await t.install(n, r, i, s) : await m(n, r, i);
				if (o) return {
					stdout: "",
					stderr: "",
					error: o,
					exitCode: 1,
					duration_ms: 0
				};
				if (t.importedPackages) {
					let t = [];
					if (await n.loadPackagesFromImports(e, {
						messageCallback: () => void 0,
						errorCallback: (e) => t.push(e)
					}), t.length) return {
						stdout: "",
						stderr: "",
						error: t.join("\n"),
						exitCode: 1,
						duration_ms: 0
					};
				}
			} catch (e) {
				return {
					...o,
					error: e instanceof Error ? e.message : String(e),
					exitCode: 1,
					duration_ms: 0
				};
			}
			let u = () => o, d = t.input ? t.input(s, u, c) : i(s.stdin, u);
			n.setStdin({ stdin: () => {
				let e = d.readLine();
				return e === null ? null : e + "\n";
			} }), c.status("running");
			let f;
			try {
				f = JSON.parse(String(await n.runPythonAsync(`await _code_notebook.run(${JSON.stringify(e)})`)));
			} catch (e) {
				f = {
					error: e instanceof Error ? e.message : String(e),
					exitCode: 1,
					figures: []
				};
			}
			for (let e of ["stdout", "stderr"]) o[e].length <= 65536 && (o[e] += l[e].decode());
			return {
				...o,
				...f,
				error: f.error ?? void 0,
				inputs: d.inputs,
				inputUnavailable: d.unavailable,
				duration_ms: 0
			};
		}
	};
}
// src/code/worker/serve.ts
function _(e) {
	let t = self.postMessage.bind(self), n, r = Promise.resolve(), i = 0, a = (e) => t(e);
	self.onmessage = (t) => {
		let o = t.data;
		!Number.isSafeInteger(o?.id) || o.id <= i || (i = o.id, r = r.then(async () => {
			let t = o.id;
			try {
				n ??= Promise.resolve().then(() => e(o));
				let r;
				try {
					r = await n;
				} catch (e) {
					a({
						id: t,
						type: "error",
						error: e instanceof Error ? e.message : String(e),
						fatal: !0
					});
					return;
				}
				let i = {
					status: (e) => a({
						id: t,
						type: "status",
						status: e
					}),
					input: (e) => a({
						...e,
						id: t
					})
				}, s;
				switch (o.op) {
					case "execute":
						s = await r.execute(o.source, o.options, i);
						break;
					case "listFiles":
						s = await r.listFiles();
						break;
					case "readFile":
						s = await r.readFile(o.name);
						break;
					case "writeFile":
						s = await r.writeFile(o.name, o.data);
						break;
					case "removeFile": s = await r.removeFile(o.name);
				}
				a({
					id: t,
					type: "result",
					value: s
				});
			} catch (e) {
				a({
					id: t,
					type: "error",
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}));
	};
}
// src/code/workers/python.ts
_((e) => {
	let { indexURL: t } = e;
	if (typeof t != "string" || !t.endsWith("/")) throw Error("Missing Python runtime URL");
	return r([new URL(t).pathname]), g(t, { importedPackages: !0 });
});
