import { toAiError } from "../core/sse";
import { AiError, type Dialect } from "../core/types";
import type { AiBackend, AiConnection, AiModel, ChatTransport, LoginResult, LoginStart } from "./types";

/** the providers of the Go package `github.com/SKevo18/vue-ai-component/go/aiserver` */
export type ServerProviderId = "chatgpt" | "codex" | "claude" | "antigravity" | "openai" | "anthropic" | "gemini";

/** one provider's entry of `GET status` */
export interface ServerProviderStatus {
  kind: "oauth" | "key";
  enabled: boolean;
  connected: boolean;
  email?: string;
  account_id?: string;
  expires_at?: string;
  /** false when the credential was sealed with another browser's key */
  key_match?: boolean;
}

type Overrides = Partial<Omit<AiConnection, "id" | "kind" | "connected" | "enabled">> & {
  /** shown in the paste step of a sign-in */
  hint?: string;
};

/** a provider id, or one with overrides of its default name, links and texts */
export type ServerProvider = ServerProviderId | ({ id: ServerProviderId } & Overrides);

export interface ServerBackendOptions {
  /** where the aiserver handler is mounted, for example `/api/ai` */
  baseUrl: string;
  fetch?: typeof fetch;
  /** extra headers of every request, for example a browser key the server seals credentials with */
  headers?: HeadersInit | (() => HeadersInit);
  /** the listed providers in this order, default every provider the server enables, sign-ins first */
  providers?: ServerProvider[];
  /** user-facing text for an error code, default the server's message */
  message?: (code: string, fallback: string) => string;
  /** adjusts each listed connection, for example with a note when `key_match` is false */
  connection?: (connection: AiConnection, status: ServerProviderStatus) => AiConnection;
}

const DEFAULTS: Record<ServerProviderId, Overrides & { name: string; dialect: Dialect }> = {
  chatgpt: { name: "ChatGPT", dialect: "responses", login: "paste", hint: "The page after the sign-in does not load. Copy its address and paste it here." },
  codex: { name: "ChatGPT (Codex)", dialect: "responses", login: "device", wire: { reasoning: true } },
  claude: { name: "Claude", dialect: "messages", login: "paste" },
  antigravity: { name: "Google", dialect: "generate", login: "paste" },
  openai: { name: "OpenAI", dialect: "responses", keysUrl: "https://platform.openai.com/api-keys", usageUrl: "https://platform.openai.com/usage" },
  anthropic: { name: "Anthropic", dialect: "messages", keysUrl: "https://console.anthropic.com/settings/keys", usageUrl: "https://console.anthropic.com/settings/usage" },
  gemini: { name: "Gemini", dialect: "generate", keysUrl: "https://aistudio.google.com/apikey", usageUrl: "https://aistudio.google.com/usage" },
};

const ORDER = Object.keys(DEFAULTS) as ServerProviderId[];

/** server codes that mean the browser must sign in again */
const AUTH_CODES = /^(not_connected|oauth_expired|oauth_key_(missing|mismatch|invalid)|unauthorized)$/;

interface StartResponse {
  flow: "device" | "code";
  login_id: string;
  authorize_url?: string;
  verification_url?: string;
  user_code?: string;
  interval?: number;
  expires_in: number;
}

interface StatusResponse {
  providers: Partial<Record<string, ServerProviderStatus>>;
}

interface ServerError {
  code: string;
  message: string;
  /** `{error: code, message}`, the shape of some hosts, which the harness cannot read */
  flat: boolean;
}

/** the code and message of a server error: `{error: {code, message}}` or `{error: code, message}` */
function serverError(body: string): ServerError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
  const { error } = parsed;
  if (typeof error === "string") {
    const message = "message" in parsed && typeof parsed.message === "string" ? parsed.message : error;
    return { code: error, message, flat: true };
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const message = "message" in error && typeof error.message === "string" ? error.message : error.code;
    return { code: error.code, message, flat: false };
  }
  return null;
}

/**
 * The backend of a server running the aiserver handler: subscription sign-ins and server-stored API keys with the
 * server's chat proxy. Merge it with createBrowserKeys to offer browser-held keys next to the sign-ins.
 */
export function createServerBackend(options: ServerBackendOptions): AiBackend {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const listed = (options.providers ?? ORDER).map((p) => (typeof p === "string" ? { id: p } : p));
  const overrides = new Map<string, Overrides>(listed.map(({ id, ...rest }) => [id, rest]));
  const logins = new Map<string, string>();
  const statuses = new Map<string, ServerProviderStatus>();

  function headers(extra: Record<string, string> = {}): Headers {
    const h = new Headers(typeof options.headers === "function" ? options.headers() : options.headers);
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return h;
  }

  function message(code: string, fallback: string): string {
    return options.message?.(code, fallback) ?? fallback;
  }

  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        credentials: "same-origin",
        // a JSON content type on every write, with or without a body, passes CSRF checks that demand one
        headers: headers(method === "GET" ? {} : { "Content-Type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError" || signal?.aborted) throw new AiError("aborted", "aborted");
      throw new AiError("network", (e as Error)?.message || "network error");
    }
    const text = await res.text();
    if (!res.ok) {
      const e = serverError(text);
      if (!e) throw toAiError(res.status, text);
      const kind = res.status === 401 || res.status === 403 || AUTH_CODES.test(e.code) ? "auth" : res.status >= 500 ? "server" : "bad_request";
      throw new AiError(kind, message(e.code, e.message), res.status, e.code);
    }
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
  }

  /** the path segment of a provider of the given kind, listing the connections first when they are unknown */
  async function provider(id: string, kind?: "oauth" | "key"): Promise<string> {
    if (!statuses.size) await backend.connections();
    const st = statuses.get(id);
    if (!st || (kind && st.kind !== kind)) throw new AiError("bad_request", `Unknown connection ${id}`);
    return encodeURIComponent(id);
  }

  /** a chat error of the server itself gets the vendor shape the harness reads, and sign-in errors become 401 */
  async function chatError(res: Response): Promise<Response> {
    if (res.ok) return res;
    const text = await res.text();
    const e = serverError(text);
    if (!e || !(e.flat || AUTH_CODES.test(e.code) || e.code.startsWith("oauth_"))) return new Response(text, { status: res.status, headers: res.headers });
    const status = AUTH_CODES.test(e.code) ? 401 : res.status;
    return new Response(JSON.stringify({ error: { code: e.code, message: message(e.code, e.message) } }), { status, headers: { "Content-Type": "application/json" } });
  }

  const backend: AiBackend = {
    async connections() {
      const { data } = await call<StatusResponse>("GET", "/status");
      const ids = options.providers
        ? listed.map((p) => p.id)
        : [...ORDER.filter((id) => data.providers[id]?.kind === "oauth"), ...ORDER.filter((id) => data.providers[id]?.kind === "key")];
      statuses.clear();
      const out: AiConnection[] = [];
      for (const id of ids) {
        const st = data.providers[id];
        if (!st) continue;
        statuses.set(id, st);
        const { hint: _hint, ...defaults } = DEFAULTS[id];
        const { hint: _override, ...over } = overrides.get(id) ?? {};
        const here = st.connected && st.key_match !== false;
        const c: AiConnection = {
          ...defaults,
          ...over,
          id,
          kind: st.kind === "oauth" ? "subscription" : "key",
          connected: here,
          account: here ? st.email || st.account_id || undefined : undefined,
          enabled: st.enabled,
        };
        out.push(options.connection ? options.connection(c, st) : c);
      }
      return out;
    },

    async startLogin(id): Promise<LoginStart> {
      const p = await provider(id, "oauth");
      const { data } = await call<StartResponse>("POST", `/oauth/${p}/start`);
      logins.set(id, data.login_id);
      if (data.flow === "device") return { kind: "device", url: data.verification_url ?? "", code: data.user_code ?? "", interval: data.interval ?? 5, expiresIn: data.expires_in };
      return { kind: "paste", url: data.authorize_url ?? "", hint: overrides.get(id)?.hint ?? DEFAULTS[id as ServerProviderId].hint, expiresIn: data.expires_in };
    },

    async completeLogin(id, pasted): Promise<LoginResult> {
      const p = await provider(id, "oauth");
      const loginId = logins.get(id);
      if (!loginId) throw new AiError("bad_request", message("oauth_login", "The sign-in attempt is unknown or expired. Start again."), 400, "oauth_login");
      const { status } = await call("POST", `/oauth/${p}/complete`, { login_id: loginId, code: (pasted ?? "").trim() });
      if (status === 202) return "pending";
      logins.delete(id);
      return "connected";
    },

    async logout(id) {
      await call("DELETE", `/oauth/${await provider(id, "oauth")}`);
    },

    async saveKey(id, key) {
      const p = await provider(id, "key");
      if (key === null) await call("DELETE", `/keys/${p}`);
      else await call("PUT", `/keys/${p}`, { api_key: key });
    },

    async models(id, signal): Promise<AiModel[]> {
      const { data } = await call<{ models?: AiModel[] }>("GET", `/${await provider(id)}/models`, undefined, signal);
      return data.models ?? [];
    },

    /** the caller sends through core/sse send, which turns a failed response into an AiError */
    transport(id): ChatTransport {
      return async ({ body }, signal) => {
        const res = await doFetch(`${base}/${await provider(id)}/chat`, {
          method: "POST",
          credentials: "same-origin",
          headers: headers({ "Content-Type": "application/json", Accept: "text/event-stream" }),
          body: JSON.stringify(body),
          signal,
        });
        return chatError(res);
      };
    },
  };
  return backend;
}
