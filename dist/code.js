// src/code/types.ts
/** `RunResult.error` of a run stopped through `RunOptions.signal` */
var RUN_STOPPED = "Stopped";
var KERNEL_LOST = "The kernel state was lost. Reset the kernel to continue.";
/** characters of stdout or stderr kept per run */
var OUTPUT_LIMIT = 65536;
function clip(text) {
	if (text.length <= 65536) return text;
	return text.slice(0, OUTPUT_LIMIT) + "\n... [output truncated]";
}
/** the input lines read within the part of stdout that clip() keeps; undefined when there are none */
function clipInputs(inputs) {
	const kept = inputs?.filter((line) => line.at <= OUTPUT_LIMIT);
	return kept?.length ? kept : void 0;
}
function timeLimitError(ms) {
	return `Time limit exceeded (${ms} ms)`;
}
// src/code/kernel.ts
var LOAD_LIMIT_MS = 18e4;
/** A time limit that can pause while the program waits for input. */
var RunClock = class {
	timer;
	left = 0;
	since = 0;
	onExpire;
	constructor(onExpire) {
		this.onExpire = onExpire;
	}
	start(ms) {
		this.stop();
		this.left = ms;
		this.resume();
	}
	pause() {
		if (this.timer === void 0) return;
		clearTimeout(this.timer);
		this.timer = void 0;
		this.left = Math.max(0, this.left - (performance.now() - this.since));
	}
	resume() {
		if (this.timer !== void 0) return;
		this.since = performance.now();
		this.timer = setTimeout(this.onExpire, this.left);
	}
	stop() {
		clearTimeout(this.timer);
		this.timer = void 0;
	}
};
function createWorkerKernel(makeWorker, config = {}) {
	const { transport, stdin } = config;
	let worker;
	let lost = false;
	let sequence = 0;
	let pending;
	let queue = Promise.resolve();
	function destroy(error) {
		if (lost) return;
		lost = true;
		worker?.terminate();
		worker = void 0;
		try {
			transport?.dispose?.();
		} finally {
			pending?.fail(error);
		}
	}
	function enqueue(action, signal) {
		const result = Promise.withResolvers();
		let started = false;
		const abort = () => {
			if (!started) result.reject(new Error(RUN_STOPPED));
		};
		signal?.addEventListener("abort", abort, { once: true });
		queue = queue.then(async () => {
			started = true;
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) return result.reject(new Error(RUN_STOPPED));
			if (lost) return result.reject(new Error(KERNEL_LOST));
			try {
				result.resolve(await action());
			} catch (error) {
				result.reject(error);
			}
		});
		if (signal?.aborted) abort();
		return result.promise;
	}
	function request(build, opts) {
		const result = Promise.withResolvers();
		const id = ++sequence;
		let done = false;
		let running = false;
		let stdinRun = null;
		let inputSequence = 0;
		const clock = new RunClock(() => destroy(timeLimitError(opts.timeoutMs)));
		let loadTimer = setTimeout(() => destroy("The runtime did not load in time"), config.loadLimitMs ?? LOAD_LIMIT_MS);
		const abort = () => destroy(RUN_STOPPED);
		const finish = (value, error) => {
			if (done) return;
			done = true;
			clearTimeout(loadTimer);
			clock.stop();
			opts?.signal?.removeEventListener("abort", abort);
			if (pending?.id === id) pending = void 0;
			if (error !== void 0) result.reject(new Error(error));
			else result.resolve(value);
		};
		pending = {
			id,
			fail: (error) => finish(void 0, error),
			receive(message) {
				if (message.type === "lost") return destroy(message.error);
				if (done || message.id !== id) return;
				if (message.type === "result") finish(message.value);
				else if (message.type === "error") {
					if (!message.fatal) return finish(void 0, message.error);
					if (message.result) finish({
						...message.result,
						error: message.error
					});
					destroy(message.error);
				} else if (message.type === "status") {
					if (message.status === "running" && opts && !running) {
						running = true;
						clearTimeout(loadTimer);
						loadTimer = void 0;
						clock.start(opts.timeoutMs);
					}
					opts?.onStatus?.(message.status);
				} else if (message.type === "input" && stdinRun && stdin && opts?.onInput && message.seq > inputSequence) {
					inputSequence = message.seq;
					clock.pause();
					const run = stdinRun;
					(async () => {
						let line = null;
						try {
							line = await opts.onInput({
								stdout: message.stdout,
								stderr: message.stderr,
								inputs: message.inputs
							});
						} catch {}
						if (done || lost || pending?.id !== id || inputSequence !== message.seq) return;
						stdin.send(run, message.seq, line);
						clock.resume();
					})();
				}
			}
		};
		opts?.signal?.addEventListener("abort", abort, { once: true });
		if (opts?.signal?.aborted) abort();
		if (!done) (async () => {
			try {
				opts?.onStatus?.("loading");
				if (!worker) {
					worker = makeWorker();
					worker.onmessage = (event) => {
						if (event.data?.type === "lost") destroy(event.data.error);
						else if (!lost && event.data?.id === pending?.id) pending?.receive(event.data);
					};
					worker.onerror = (event) => {
						event.preventDefault();
						destroy(event.message || "The kernel worker failed");
					};
					worker.onmessageerror = () => destroy("The kernel response could not be read");
				}
				const message = await build(id);
				if (done || lost) return;
				if (message.op === "execute") stdinRun = message.options.stdinRun;
				if (transport) await transport.send(worker, message);
				else worker.postMessage(message);
			} catch (error) {
				if (!done) destroy(error instanceof Error ? error.message : String(error));
			}
		})();
		return result.promise;
	}
	return {
		get lost() {
			return lost;
		},
		async execute(source, opts) {
			const started = performance.now();
			try {
				const value = await enqueue(() => request(async (id) => {
					const stdinRun = opts.onInput && stdin ? await stdin.open() : null;
					return {
						id,
						op: "execute",
						source,
						options: {
							...config.execution?.(opts),
							stdin: opts.stdin ?? "",
							stdinRun,
							packages: opts.packages ?? []
						}
					};
				}, opts), opts.signal);
				return {
					...value,
					stdout: clip(value.stdout),
					stderr: clip(value.stderr),
					inputs: clipInputs(value.inputs),
					inputUnavailable: !!opts.onInput && !!value.inputUnavailable,
					duration_ms: Math.round(performance.now() - started)
				};
			} catch (error) {
				return {
					stdout: "",
					stderr: "",
					error: error instanceof Error ? error.message : String(error),
					exitCode: 1,
					duration_ms: Math.round(performance.now() - started)
				};
			}
		},
		listFiles: () => enqueue(() => request((id) => ({
			id,
			op: "listFiles"
		}))),
		readFile: (name) => enqueue(() => request((id) => ({
			id,
			op: "readFile",
			name
		}))),
		writeFile(name, data) {
			const bytes = data.slice();
			return enqueue(() => request((id) => ({
				id,
				op: "writeFile",
				name,
				data: bytes
			})));
		},
		removeFile: (name) => enqueue(() => request((id) => ({
			id,
			op: "removeFile",
			name
		}))),
		dispose: () => destroy(KERNEL_LOST)
	};
}
// src/code/workspace.ts
var CODE_LANGUAGES = ["python", "javascript"];
/** characters of stdout, stderr or error per run: the start and the end of longer output */
var OUTPUT_CHARS = 12e3;
var MAX_FILE_BYTES = 20971520;
var MAX_IMAGES = 6;
var MAX_LISTED_FILES = 200;
/**
* Workspace paths of attachments: attachments/<name> with the name reduced to letters, digits, dot, dash and
* underscore; repeated names get -2, -3 before the extension.
*/
function attachmentPaths(files) {
	const taken = /* @__PURE__ */ new Set();
	const out = /* @__PURE__ */ new Map();
	for (const file of files) {
		const clean = file.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-80) || "file";
		const dot = clean.lastIndexOf(".");
		const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
		let path = `attachments/${clean}`;
		for (let n = 2; taken.has(path); n++) path = `attachments/${stem}-${n}${ext}`;
		taken.add(path);
		out.set(file.id, path);
	}
	return out;
}
/** Long output keeps its start and end around a marker naming the omitted length. */
function clipOutput(text, limit = OUTPUT_CHARS) {
	if (text.length <= limit) return text;
	const head = Math.floor(limit * 2 / 3);
	const tail = limit - head;
	return `${text.slice(0, head)}\n[... ${text.length - limit} characters omitted; print less ...]\n${text.slice(-tail)}`;
}
function rasterMime(bytes) {
	if (bytes.length >= 8 && [
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	].every((n, i) => bytes[i] === n)) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
	if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return null;
}
async function base64(blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
	return btoa(binary);
}
/** SVG drawn on white as PNG: models take raster images only. Scripts in the SVG never run in an image element. */
async function svgToPng(blob) {
	const url = URL.createObjectURL(new Blob([blob], { type: "image/svg+xml" }));
	const canvas = document.createElement("canvas");
	try {
		const image = new Image();
		image.src = url;
		await image.decode().catch(() => {
			throw new Error("The browser cannot draw this SVG image.");
		});
		const scale = Math.min(1, 1536 / Math.max(image.naturalWidth || 1536, image.naturalHeight || 1536));
		canvas.width = Math.max(1, Math.round((image.naturalWidth || 1536) * scale));
		canvas.height = Math.max(1, Math.round((image.naturalHeight || 1536) * scale));
		const context = canvas.getContext("2d");
		context.fillStyle = "white";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const done = Promise.withResolvers();
		canvas.toBlob((b) => b ? done.resolve(b) : done.reject(/* @__PURE__ */ new Error("The SVG image could not be converted.")), "image/png");
		return await done.promise;
	} finally {
		URL.revokeObjectURL(url);
		canvas.width = canvas.height = 0;
	}
}
/** The image as base64 with its type, or a reason it is not one. */
async function toImage(name, blob) {
	const mime = rasterMime(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
	if (mime) return {
		name,
		mimeType: mime,
		data: await base64(blob)
	};
	if (blob.type === "image/svg+xml" || /\.svg$/i.test(name)) return {
		name,
		mimeType: "image/png",
		data: await base64(await svgToPng(blob))
	};
	return `show: ${name} is not a PNG, JPEG, GIF, WebP or SVG image.`;
}
var CodeWorkspace = class {
	slots = /* @__PURE__ */ new Map();
	createKernel;
	constructor(createKernel) {
		this.createKernel = createKernel;
	}
	/** Ends every kernel; the next run starts fresh. */
	dispose() {
		for (const slot of this.slots.values()) slot.kernel.dispose();
		this.slots.clear();
	}
	slot(language) {
		let slot = this.slots.get(language);
		if (!slot) {
			slot = {
				kernel: this.createKernel(language),
				mounted: /* @__PURE__ */ new Map()
			};
			this.slots.set(language, slot);
		}
		return slot;
	}
	/** Writes attachments and host files that are missing or changed, removes attachments no longer attached. */
	async mount(slot, attachments, extra, notes) {
		const wanted = /* @__PURE__ */ new Map();
		for (const [id, path] of attachmentPaths(attachments)) wanted.set(path, attachments.find((f) => f.id === id));
		for (const [path, source] of slot.mounted) if (source.startsWith("attachment:") && `attachment:${wanted.get(path)?.id}` !== source) {
			await slot.kernel.removeFile(path).catch(() => void 0);
			slot.mounted.delete(path);
		}
		for (const [path, file] of wanted) {
			if (slot.mounted.get(path) === `attachment:${file.id}`) continue;
			try {
				await slot.kernel.writeFile(path, new Uint8Array(await file.blob.arrayBuffer()));
				slot.mounted.set(path, `attachment:${file.id}`);
			} catch (e) {
				notes.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		for (const file of extra) {
			if (slot.mounted.get(file.path) === file.source) continue;
			try {
				const blob = await file.blob();
				if (blob.size > 20971520) throw new Error(`${file.source} is larger than 20 MiB.`);
				await slot.kernel.writeFile(file.path, new Uint8Array(await blob.arrayBuffer()));
				slot.mounted.set(file.path, file.source);
			} catch (e) {
				notes.push(e instanceof Error ? e.message : String(e));
			}
		}
	}
	async run(request, attachments = [], mounts = {
		files: [],
		notes: []
	}) {
		const { language } = request;
		const notes = [...mounts.notes];
		const slot = this.slot(language);
		await this.mount(slot, attachments, mounts.files, notes);
		const result = await slot.kernel.execute(request.code, {
			timeoutMs: request.timeoutMs,
			packages: language === "python" ? request.packages : void 0,
			signal: request.signal
		});
		const blobs = (result.figures ?? []).map((data, i) => ({
			name: `figure-${i + 1}.png`,
			blob: new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "image/png" })
		}));
		let files = [];
		if (slot.kernel.lost) {
			slot.kernel.dispose();
			this.slots.delete(language);
			notes.push("The workspace was reset (time limit, stop or crash): variables and written files are gone; attachments are mounted again on the next run.");
		} else {
			files = await slot.kernel.listFiles();
			for (const path of request.show ?? []) {
				const file = files.find((f) => f.name === path);
				if (!file) notes.push(`show: no file ${path} in the workspace.`);
				else if (file.size > 20971520) notes.push(`show: ${path} is larger than 20 MiB.`);
				else blobs.push({
					name: path.split("/").pop(),
					blob: new Blob([(await slot.kernel.readFile(path)).slice()])
				});
			}
		}
		const images = [];
		for (const { name, blob } of blobs) {
			if (images.length >= MAX_IMAGES) {
				notes.push(`Only the first ${MAX_IMAGES} images of a run are shown.`);
				break;
			}
			try {
				const image = await toImage(name, blob);
				if (typeof image === "string") notes.push(image);
				else images.push(image);
			} catch (e) {
				notes.push(`show: ${name}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return {
			result: {
				language,
				ok: !result.error,
				stdout: clipOutput(result.stdout),
				stderr: clipOutput(result.stderr),
				...result.error && { error: clipOutput(result.error) },
				duration_ms: result.duration_ms,
				files: files.slice(0, MAX_LISTED_FILES).map(({ name, size }) => ({
					name,
					size
				})),
				...files.length > MAX_LISTED_FILES && { files_total: files.length },
				...notes.length && { notes }
			},
			images
		};
	}
};
// src/code/tool.ts
/** String fields that leave the JSON head when they span lines, so long text reaches the model unescaped. */
var RAW_FIELDS = {
	text: true,
	stdout: true,
	stderr: true,
	error: true
};
/** A result object as one JSON line followed by its multi-line text fields as `--- field ---` sections. */
function serializeResult(value) {
	const head = {};
	const sections = [];
	for (const [key, v] of Object.entries(value)) if (typeof v === "string" && RAW_FIELDS[key] && v.includes("\n")) sections.push(`--- ${key} ---\n${v}`);
	else head[key] = v;
	return [JSON.stringify(head), ...sections].join("\n");
}
function folder(url) {
	const resolved = new URL(url, location.href);
	if (!resolved.pathname.endsWith("/")) resolved.pathname += "/";
	return resolved;
}
/** The bundled workers served from `assetsUrl`. */
function bundledKernel(options) {
	return (language) => {
		const assets = folder(options.assetsUrl);
		if (language === "javascript") return createWorkerKernel(() => new Worker(new URL("javascript-worker.js", assets), { name: "run_code javascript" }));
		const indexURL = folder(options.pyodideUrl).href;
		return createWorkerKernel(() => new Worker(new URL("python-worker.js", assets), {
			type: "module",
			name: "run_code python"
		}), { transport: { send(worker, request) {
			worker.postMessage({
				...request,
				indexURL
			});
		} } });
	};
}
function createCodeTool(options) {
	const available = options.kernel ? CODE_LANGUAGES : CODE_LANGUAGES.filter((language) => options.assetsUrl && (language === "javascript" || options.pyodideUrl));
	const languages = (options.languages ?? available).filter((language) => available.includes(language));
	if (!languages.length) throw new Error("createCodeTool needs assetsUrl (and pyodideUrl for Python) or a kernel factory.");
	const createKernel = options.kernel ?? bundledKernel(options);
	const timeoutMs = options.timeLimitMs ?? 12e4;
	let current = null;
	const python = languages.includes("python");
	const description = [
		`Runs ${languages.map((language) => language === "python" ? "Python (Pyodide)" : "JavaScript").join(" or ")} in a sandbox in the user's browser, in a workspace kept for this conversation: variables, imports and files persist between calls until the page reloads or the conversation changes (a time limit or crash resets it). Files attached to the conversation are mounted as attachments/<name>; the result lists the workspace files.`,
		options.mounts?.description,
		`Use it to inspect large or binary files without reading them whole, to parse and analyse data and to calculate instead of doing arithmetic in your head. stdout, stderr and error are cut to 12000 characters each (start and end kept): print summaries, not whole files.`,
		languages.includes("javascript") ? "JavaScript runs as a classic script: console.log prints, fs.readFileSync/writeFileSync/readdirSync and require(\"fs\") work on the workspace files, top-level declarations persist." : void 0,
		python ? "Python allows top-level await; matplotlib figures come back as images you can see." : void 0,
		"Image files named in show (PNG, JPEG, GIF, WebP, SVG) come back as images. No network access. The user sees the code and the output.",
		options.description
	].filter(Boolean).join(" ");
	const parameters = {
		type: "object",
		properties: {
			language: {
				type: "string",
				enum: [...languages],
				description: "Each language has its own interpreter and files."
			},
			code: {
				type: "string",
				minLength: 1,
				description: python ? "Program to run; Python allows top-level await." : "Program to run."
			},
			...python && { packages: {
				type: "array",
				items: { type: "string" },
				description: "Python packages to load first, e.g. [\"numpy\", \"pandas\", \"matplotlib\"]. Imports of distribution packages also load on their own."
			} },
			show: {
				type: "array",
				items: { type: "string" },
				description: "Workspace paths of image files to look at after the run."
			},
			...options.mounts?.parameters
		},
		required: ["language", "code"],
		additionalProperties: false
	};
	async function run(args, ctx) {
		const language = args.language;
		if (!languages.includes(language)) return {
			text: `run_code runs ${languages.join(" or ")}, not ${String(language)}.`,
			isError: true
		};
		const packages = Array.isArray(args.packages) ? args.packages : void 0;
		const refused = language === "python" && packages?.length ? options.packagePolicy?.(packages) : null;
		if (refused) return {
			text: refused,
			isError: true
		};
		if (current?.conversationId !== ctx.conversationId) {
			current?.workspace.dispose();
			current = {
				conversationId: ctx.conversationId,
				workspace: new CodeWorkspace(createKernel)
			};
		}
		const { workspace } = current;
		const attachments = (await ctx.files()).map((file) => ({
			id: file.uri,
			name: file.name,
			blob: file.blob
		}));
		const mounts = options.mounts ? await options.mounts.files(args, ctx.signal) : void 0;
		ctx.onProgress?.(`Running ${language}`);
		const { result, images } = await workspace.run({
			language,
			code: String(args.code),
			packages,
			show: Array.isArray(args.show) ? args.show : void 0,
			timeoutMs,
			signal: ctx.signal
		}, attachments, mounts);
		const saved = [];
		for (const image of images) saved.push(await ctx.saveImage({
			mimeType: image.mimeType,
			data: image.data
		}, image.name));
		return {
			text: serializeResult({
				...result,
				...images.length && { images: images.map((image) => image.name) }
			}),
			images: saved.length ? saved : void 0
		};
	}
	return {
		name: "run_code",
		title: "Run code",
		description,
		parameters,
		approval: options.approval ?? "auto",
		readOnly: false,
		run
	};
}
export { CODE_LANGUAGES, CodeWorkspace, KERNEL_LOST, MAX_FILE_BYTES, OUTPUT_CHARS, OUTPUT_LIMIT, RUN_STOPPED, RunClock, attachmentPaths, clip, clipInputs, clipOutput, createCodeTool, createWorkerKernel, serializeResult, timeLimitError };
