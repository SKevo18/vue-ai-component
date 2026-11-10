import { send } from "../core/sse";
import { AiError, type Dialect } from "../core/types";
import type { AiBackend, AiConnection, AiModel, ChatTransport } from "./types";

export type KeyProvider = "openai" | "anthropic" | "gemini";

interface Vendor {
  name: string;
  dialect: Dialect;
  keysUrl: string;
  usageUrl: string;
}

const VENDORS: Record<KeyProvider, Vendor> = {
  openai: { name: "OpenAI", dialect: "responses", keysUrl: "https://platform.openai.com/api-keys", usageUrl: "https://platform.openai.com/usage" },
  anthropic: { name: "Anthropic", dialect: "messages", keysUrl: "https://console.anthropic.com/settings/keys", usageUrl: "https://console.anthropic.com/settings/usage" },
  gemini: { name: "Gemini", dialect: "generate", keysUrl: "https://aistudio.google.com/apikey", usageUrl: "https://aistudio.google.com/usage" },
};

const OPENAI_SKIP = /image|realtime|audio|tts|transcribe|search|instruct|embedding|moderation|dall-e|whisper/;

export interface BrowserKeysOptions {
  /** default `ai:`; keys live under `<prefix>key:<provider>` */
  prefix?: string;
  storage?: Storage;
  providers?: KeyProvider[];
  fetch?: typeof fetch;
  baseUrls?: Partial<Record<KeyProvider, string>>;
}

export interface BrowserKeys extends AiBackend {
  saveKey(id: string, key: string | null): Promise<void>;
  clearBrowserKeys(): Promise<void>;
}

const BASES: Record<KeyProvider, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

function mask(key: string): string {
  return key.length > 12 ? `${key.slice(0, 3)}...${key.slice(-4)}` : "...";
}

export function createBrowserKeys(options: BrowserKeysOptions = {}): BrowserKeys {
  const prefix = options.prefix ?? "ai:";
  const storage = () => options.storage ?? globalThis.localStorage;
  const providers = options.providers ?? (["openai", "anthropic", "gemini"] as KeyProvider[]);
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const base = (p: KeyProvider) => options.baseUrls?.[p] ?? BASES[p];

  function provider(id: string): KeyProvider {
    const p = providers.find((x) => x === id);
    if (!p) throw new AiError("bad_request", `Unknown key provider ${id}`);
    return p;
  }

  function read(id: string): string {
    try {
      return storage()?.getItem(`${prefix}key:${id}`) ?? "";
    } catch {
      return "";
    }
  }

  function headers(p: KeyProvider, key: string): Record<string, string> {
    if (p === "openai") return { Authorization: `Bearer ${key}` };
    if (p === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    return { "x-goog-api-key": key };
  }

  async function listModels(p: KeyProvider, key: string, signal?: AbortSignal): Promise<AiModel[]> {
    if (!key) throw new AiError("auth", `No ${VENDORS[p].name} key is saved`);
    const get = async <T>(path: string) => (await (await send(() => doFetch(base(p) + path, { headers: headers(p, key), signal }), signal)).json()) as T;
    if (p === "openai") {
      const res = await get<{ data?: { id: string; created?: number }[] }>("/v1/models");
      return (res.data ?? [])
        .filter((m) => /^(gpt-|chatgpt-|o\d)/.test(m.id) && !OPENAI_SKIP.test(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => ({ id: m.id }));
    }
    if (p === "anthropic") {
      const res = await get<{ data?: { id: string; display_name?: string }[] }>("/v1/models?limit=1000");
      return (res.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
    }
    const res = await get<{ models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] }>("/v1beta/models?pageSize=1000");
    return (res.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName }))
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  return {
    async connections(): Promise<AiConnection[]> {
      return providers.map((p) => {
        const key = read(p);
        return { id: p, kind: "key", dialect: VENDORS[p].dialect, name: VENDORS[p].name, connected: !!key, account: key ? mask(key) : undefined, enabled: true, keysUrl: VENDORS[p].keysUrl, usageUrl: VENDORS[p].usageUrl };
      });
    },
    async saveKey(id, key) {
      const p = provider(id);
      const trimmed = key?.trim() ?? "";
      if (trimmed) await listModels(p, trimmed);
      try {
        if (trimmed) storage()?.setItem(`${prefix}key:${p}`, trimmed);
        else storage()?.removeItem(`${prefix}key:${p}`);
      } catch {
        throw new AiError("unknown", "This browser cannot store the key.");
      }
    },
    async clearBrowserKeys() {
      try {
        for (const p of Object.keys(VENDORS)) storage()?.removeItem(`${prefix}key:${p}`);
      } catch {
        throw new AiError("unknown", "This browser cannot remove the keys.");
      }
    },
    models: (id, signal) => listModels(provider(id), read(id), signal),
    transport(id): ChatTransport {
      const p = provider(id);
      return ({ model, body }, signal) => {
        const key = read(p);
        if (!key) return Promise.reject(new AiError("auth", `No ${VENDORS[p].name} key is saved`));
        const init = (payload: unknown): RequestInit => ({ method: "POST", headers: { ...headers(p, key), "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(payload), signal });
        if (p === "openai") return doFetch(`${base(p)}/v1/responses`, init(body));
        if (p === "anthropic") return doFetch(`${base(p)}/v1/messages`, init(body));
        const rest = { ...body };
        delete rest.model;
        return doFetch(`${base(p)}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, init(rest));
      };
    },
  };
}

/** each id goes to the first backend that lists it; a backend that fails to list is skipped unless all fail */
export function mergeBackends(...backends: AiBackend[]): AiBackend {
  const owners = new Map<string, AiBackend>();
  async function owner(id: string): Promise<AiBackend> {
    if (!owners.has(id)) await merged.connections();
    const b = owners.get(id);
    if (!b) throw new AiError("bad_request", `Unknown connection ${id}`);
    return b;
  }
  const merged: AiBackend = {
    async connections() {
      const settled = await Promise.allSettled(backends.map((b) => b.connections()));
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (rejected.length && rejected.length === settled.length) throw rejected[0]!.reason;
      const out: AiConnection[] = [];
      owners.clear();
      settled.forEach((result, i) => {
        if (result.status === "rejected") return;
        for (const c of result.value) {
          if (owners.has(c.id)) continue;
          owners.set(c.id, backends[i]!);
          out.push(c);
        }
      });
      return out;
    },
    async startLogin(id) {
      const b = await owner(id);
      if (!b.startLogin) throw new AiError("bad_request", `${id} has no sign-in`);
      return b.startLogin(id);
    },
    async completeLogin(id, pasted) {
      const b = await owner(id);
      if (!b.completeLogin) throw new AiError("bad_request", `${id} has no sign-in`);
      return b.completeLogin(id, pasted);
    },
    async logout(id) {
      const b = await owner(id);
      if (!b.logout) throw new AiError("bad_request", `${id} cannot sign out`);
      return b.logout(id);
    },
    async saveKey(id, key) {
      const b = await owner(id);
      if (!b.saveKey) throw new AiError("bad_request", `${id} does not take a key`);
      return b.saveKey(id, key);
    },
    models: async (id, signal) => (await owner(id)).models(id, signal),
    transport(id) {
      return async (request, signal) => (await owner(id)).transport(id)(request, signal);
    },
  };
  const browserBackends = backends.filter((b) => b.clearBrowserKeys);
  if (browserBackends.length) merged.clearBrowserKeys = async () => {
    await Promise.all(browserBackends.map((b) => b.clearBrowserKeys!()));
  };
  return merged;
}
