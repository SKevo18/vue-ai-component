import { SseParser } from "../core/sse";
import { MCP_PROTOCOL_VERSION, McpError, type McpResource, type McpResourceContents, type McpResourceTemplate, type McpServerInfo, type McpTool, type McpToolResult } from "./types";

export interface McpClientOptions {
  url: string;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
  /** default `include`, so the app's session cookie goes along */
  credentials?: RequestCredentials;
  clientInfo?: { name: string; version: string };
}

export interface McpRequestOptions {
  signal?: AbortSignal;
}

export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallOptions extends McpRequestOptions {
  /** progress notifications also keep long calls alive behind idle-timeout proxies */
  onProgress?(progress: McpProgress): void;
}

export interface McpListOptions extends McpRequestOptions {
  refresh?: boolean;
}

export interface McpClient {
  readonly url: string;
  readonly info: McpServerInfo | null;
  connect(options?: McpRequestOptions): Promise<McpServerInfo>;
  listTools(options?: McpListOptions): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<McpToolResult>;
  listResources(options?: McpListOptions): Promise<McpResource[]>;
  listResourceTemplates(options?: McpListOptions): Promise<McpResourceTemplate[]>;
  readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContents[]>;
  request<T>(method: string, params?: Record<string, unknown>, options?: McpRequestOptions): Promise<T>;
  reset(): void;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: Record<string, unknown>;
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let nextId = 1;
  let sessionId: string | null = null;
  let info: McpServerInfo | null = null;
  let connecting: Promise<McpServerInfo> | null = null;
  const lists = new Map<string, Promise<unknown[]>>();

  function aborted(signal?: AbortSignal): McpError {
    const reason = signal?.reason;
    return new McpError("aborted", reason instanceof Error && reason.message ? reason.message : "The request was cancelled.");
  }

  async function post(body: object, initialized: boolean, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      ...(await options.headers?.()),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (initialized && info) headers["MCP-Protocol-Version"] = info.protocolVersion;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    try {
      return await doFetch(options.url, { method: "POST", headers, body: JSON.stringify(body), credentials: options.credentials ?? "include", signal });
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === "AbortError") throw aborted(signal);
      throw new McpError("network", `Cannot reach the MCP server: ${(e as Error)?.message || "network error"}`);
    }
  }

  async function httpError(res: Response): Promise<McpError> {
    const text = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as RpcResponse & { error?: { message?: string } | string; message?: string };
      if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.code === "number") {
        return new McpError("rpc", parsed.error.message, { code: parsed.error.code, status: res.status, data: parsed.error.data });
      }
      const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
      if (message) return new McpError("http", `MCP server answered ${res.status}: ${message}`, { status: res.status });
    } catch {
      // a body that is not JSON is reported as text below
    }
    const detail = text.trim().slice(0, 200);
    return new McpError("http", `MCP server answered ${res.status}${detail ? `: ${detail}` : ""}`, { status: res.status });
  }

  async function responseFor(res: Response, id: number, signal?: AbortSignal, onMessage?: (m: RpcResponse) => void): Promise<RpcResponse> {
    const type = res.headers.get("Content-Type") ?? "";
    if (type.includes("text/event-stream")) {
      if (!res.body) throw new McpError("protocol", "The MCP server sent an empty stream.");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (signal?.aborted || (e as Error)?.name === "AbortError") throw aborted(signal);
            throw new McpError("network", `The MCP stream broke: ${(e as Error)?.message || "network error"}`);
          }
          const events = chunk.done ? parser.end() : parser.push(decoder.decode(chunk.value, { stream: true }));
          for (const ev of events) {
            if (ev.event && ev.event !== "message") continue;
            let msg: RpcResponse | RpcResponse[];
            try {
              msg = JSON.parse(ev.data) as RpcResponse | RpcResponse[];
            } catch {
              continue;
            }
            for (const m of Array.isArray(msg) ? msg : [msg]) {
              if (m.id === id && !m.method) return m;
              if (m.method) onMessage?.(m);
            }
          }
          if (chunk.done) throw new McpError("protocol", "The MCP stream ended without a response.");
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
    }
    let parsed: RpcResponse | RpcResponse[];
    try {
      parsed = (await res.json()) as RpcResponse | RpcResponse[];
    } catch (e) {
      if (signal?.aborted) throw aborted(signal);
      throw new McpError("protocol", `The MCP server sent invalid JSON${type ? ` (${type})` : ""}.`);
    }
    const found = (Array.isArray(parsed) ? parsed : [parsed]).find((m) => m.id === id);
    if (!found) throw new McpError("protocol", "The MCP server did not answer the request.");
    return found;
  }

  async function call<T>(method: string, params: Record<string, unknown> | undefined, initialized: boolean, signal?: AbortSignal, onMessage?: (m: RpcResponse) => void): Promise<T> {
    const id = nextId++;
    const res = await post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, initialized, signal);
    if (!res.ok) throw await httpError(res);
    const msg = await responseFor(res, id, signal, onMessage);
    if (msg.error) throw new McpError("rpc", msg.error.message || `MCP error ${msg.error.code}`, { code: msg.error.code, data: msg.error.data });
    return msg.result as T;
  }

  async function notify(method: string): Promise<void> {
    const res = await post({ jsonrpc: "2.0", method }, true);
    if (!res.ok && res.status !== 202) throw await httpError(res);
    await res.body?.cancel().catch(() => undefined);
  }

  async function initialize(signal?: AbortSignal): Promise<McpServerInfo> {
    sessionId = null;
    const id = nextId++;
    const res = await post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: options.clientInfo ?? { name: "vue-ai-component", version: "1" } },
      },
      false,
      signal,
    );
    if (!res.ok) throw await httpError(res);
    sessionId = res.headers.get("Mcp-Session-Id");
    const msg = await responseFor(res, id, signal);
    if (msg.error) throw new McpError("rpc", msg.error.message, { code: msg.error.code, data: msg.error.data });
    const result = msg.result as McpServerInfo;
    if (!result || typeof result.protocolVersion !== "string") throw new McpError("protocol", "The MCP server sent an invalid initialize result.");
    info = { ...result, capabilities: result.capabilities ?? {} };
    await notify("notifications/initialized");
    return info;
  }

  function connect(opts: McpRequestOptions = {}): Promise<McpServerInfo> {
    if (info) return Promise.resolve(info);
    if (!connecting) {
      connecting = initialize(opts.signal).finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  async function request<T>(method: string, params?: Record<string, unknown>, opts: McpRequestOptions = {}, onMessage?: (m: RpcResponse) => void): Promise<T> {
    await connect(opts);
    try {
      return await call<T>(method, params, true, opts.signal, onMessage);
    } catch (e) {
      // a server that dropped the session answers 404: start a new one and try once more
      if (!(e instanceof McpError) || e.status !== 404 || !sessionId) throw e;
      reset();
      await connect(opts);
      return call<T>(method, params, true, opts.signal, onMessage);
    }
  }

  function list<T>(method: string, key: string, opts: McpListOptions): Promise<T[]> {
    let pending = lists.get(method) as Promise<T[]> | undefined;
    if (!pending || opts.refresh) {
      pending = (async () => {
        const out: T[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 1000; page++) {
          const result = await request<Record<string, unknown>>(method, cursor ? { cursor } : undefined, opts);
          const items = result?.[key];
          if (Array.isArray(items)) out.push(...(items as T[]));
          cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
          if (!cursor) break;
        }
        return out;
      })();
      lists.set(method, pending);
      pending.catch(() => {
        if (lists.get(method) === pending) lists.delete(method);
      });
    }
    return pending;
  }

  function reset() {
    sessionId = null;
    info = null;
    connecting = null;
    lists.clear();
  }

  return {
    url: options.url,
    get info() {
      return info;
    },
    connect,
    request: (method, params, opts) => request(method, params, opts),
    reset,
    listTools: (opts = {}) => list<McpTool>("tools/list", "tools", opts),
    listResources: (opts = {}) => list<McpResource>("resources/list", "resources", opts),
    listResourceTemplates: (opts = {}) => list<McpResourceTemplate>("resources/templates/list", "resourceTemplates", opts),
    async callTool(name, args, opts = {}) {
      const token = `call-${nextId}-${Math.random().toString(36).slice(2, 10)}`;
      const onMessage = (m: RpcResponse) => {
        const p = m.params;
        if (m.method !== "notifications/progress" || p?.progressToken !== token || typeof p.progress !== "number") return;
        opts.onProgress?.({ progress: p.progress, total: typeof p.total === "number" ? p.total : undefined, message: typeof p.message === "string" ? p.message : undefined });
      };
      const result = await request<McpToolResult>("tools/call", { name, arguments: args, _meta: { progressToken: token } }, opts, onMessage);
      return { ...result, content: Array.isArray(result?.content) ? result.content : [] };
    },
    async readResource(uri, opts = {}) {
      const result = await request<{ contents?: McpResourceContents[] }>("resources/read", { uri }, opts);
      return Array.isArray(result?.contents) ? result.contents : [];
    },
  };
}
