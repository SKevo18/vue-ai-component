import { describe, expect, it, vi } from "vitest";
import { createBrowserKeys, mergeBackends } from "./browser-keys";
import type { AiBackend } from "./types";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
    key: (index) => [...items.keys()][index] ?? null,
  };
}

describe("browser keys", () => {
  it("lists vendor usage links for all supported key providers", async () => {
    const keys = createBrowserKeys({ storage: memoryStorage() });
    const connections = await keys.connections();
    expect(connections.map((c) => [c.id, c.usageUrl])).toEqual([
      ["openai", "https://platform.openai.com/usage"],
      ["anthropic", "https://console.anthropic.com/settings/usage"],
      ["gemini", "https://aistudio.google.com/usage"],
    ]);
  });

  it("clears only provider keys in its namespace, including providers currently disabled in configuration", async () => {
    const storage = memoryStorage();
    for (const provider of ["openai", "anthropic", "gemini"]) storage.setItem(`app:ai:key:${provider}`, `secret-${provider}`);
    storage.setItem("other:ai:key:openai", "other-app-secret");
    storage.setItem("app:ai:preferences", "preferences");
    storage.setItem("app:ai:server-token", "server-secret");
    storage.setItem("unrelated", "keep");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const keys = createBrowserKeys({ storage, prefix: "app:ai:", providers: ["openai"], fetch });
    expect((await keys.connections())[0]!.connected).toBe(true);
    await keys.clearBrowserKeys();
    expect((await keys.connections())[0]!.connected).toBe(false);
    expect(storage.getItem("app:ai:key:openai")).toBeNull();
    expect(storage.getItem("app:ai:key:anthropic")).toBeNull();
    expect(storage.getItem("app:ai:key:gemini")).toBeNull();
    expect(storage.getItem("other:ai:key:openai")).toBe("other-app-secret");
    expect(storage.getItem("app:ai:preferences")).toBe("preferences");
    expect(storage.getItem("app:ai:server-token")).toBe("server-secret");
    expect(storage.getItem("unrelated")).toBe("keep");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces storage failures instead of claiming keys were removed", async () => {
    const storage = memoryStorage();
    storage.setItem("ai:key:openai", "secret");
    storage.removeItem = () => { throw new Error("Storage denied"); };
    const keys = createBrowserKeys({ storage });
    await expect(keys.clearBrowserKeys()).rejects.toThrow("This browser cannot remove the keys.");
    expect(storage.getItem("ai:key:openai")).toBe("secret");
  });
});

describe("mergeBackends browser key clearing", () => {
  it("routes normal disconnect to the owning server but clears only browser keys even when ids collide", async () => {
    const storage = memoryStorage();
    storage.setItem("ai:key:openai", "browser-secret");
    const browser = createBrowserKeys({ storage, providers: ["openai"] });
    const server: AiBackend = {
      connections: async () => [{ id: "openai", name: "Server OpenAI", kind: "key", dialect: "responses", connected: true, enabled: true }],
      saveKey: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      models: async () => [],
      transport: () => async () => new Response(""),
    };
    const backend = mergeBackends(server, browser);
    expect((await backend.connections()).map((c) => c.name)).toEqual(["Server OpenAI"]);
    await backend.saveKey!("openai", null);
    expect(server.saveKey).toHaveBeenCalledWith("openai", null);
    vi.mocked(server.saveKey!).mockClear();
    await backend.clearBrowserKeys!();
    expect(storage.getItem("ai:key:openai")).toBeNull();
    expect(server.saveKey).not.toHaveBeenCalled();
    expect(server.logout).not.toHaveBeenCalled();
    expect((await backend.connections())[0]!.connected).toBe(true);
  });

  it("forwards clearing through nested merges to each browser namespace", async () => {
    const storage = memoryStorage();
    storage.setItem("one:key:openai", "first");
    storage.setItem("two:key:openai", "second");
    const one = createBrowserKeys({ storage, prefix: "one:" });
    const two = createBrowserKeys({ storage, prefix: "two:" });
    const backend = mergeBackends(mergeBackends(one), two);
    await backend.clearBrowserKeys!();
    expect(storage.getItem("one:key:openai")).toBeNull();
    expect(storage.getItem("two:key:openai")).toBeNull();
  });

  it("omits the destructive action when no browser backend provides it", () => {
    const server: AiBackend = { connections: async () => [], models: async () => [], transport: () => async () => new Response("") };
    expect(mergeBackends(server).clearBrowserKeys).toBeUndefined();
  });
});

describe("mergeBackends failures", () => {
  it("keeps the other backends usable when one cannot list its connections", async () => {
    const storage = memoryStorage();
    storage.setItem("ai:key:openai", "browser-secret");
    const server: AiBackend = { connections: async () => { throw new Error("Server down"); }, models: async () => [], transport: () => async () => new Response("") };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [{ id: "gpt-otter" }] })));
    const backend = mergeBackends(server, createBrowserKeys({ storage, providers: ["openai"], fetch }));
    expect((await backend.connections()).map((c) => [c.id, c.connected])).toEqual([["openai", true]]);
    expect(await backend.models("openai")).toEqual([{ id: "gpt-otter" }]);
  });

  it("fails when every backend fails", async () => {
    const down: AiBackend = { connections: async () => { throw new Error("Server down"); }, models: async () => [], transport: () => async () => new Response("") };
    await expect(mergeBackends(down, down).connections()).rejects.toThrow("Server down");
  });
});
