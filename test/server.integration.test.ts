// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerBackend, type ServerBackendOptions } from "../src/backend/server";
import { send } from "../src/core/sse";
import { AiError } from "../src/core/types";
import { hasGo, startAiFixture, type Fixture } from "./fixture-server";

const go = hasGo();
if (!go) console.warn("skipping aiserver integration tests: `go` is not installed, so the fixture server cannot be built");

describe.skipIf(!go)("createServerBackend against the Go aiserver handler", () => {
  let fixture: Fixture;
  const backend = (user: string, options: Partial<ServerBackendOptions> = {}) =>
    createServerBackend({ baseUrl: `${fixture.url}/api/ai/`, headers: { "X-User": user }, ...options });
  const steer = (state: { approved?: boolean; challenge?: string }) =>
    fetch(`${fixture.url}/fake/vendors`, { method: "POST", body: JSON.stringify(state) });
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AiError);

  beforeAll(async () => {
    fixture = await startAiFixture();
  });
  afterAll(() => fixture?.stop());

  it("lists sign-ins before API keys with the server's gate", async () => {
    const list = await backend("ollie").connections();
    expect(list.map((c) => [c.id, c.kind, c.name, c.enabled, c.connected])).toEqual([
      ["chatgpt", "subscription", "ChatGPT", true, false],
      ["codex", "subscription", "ChatGPT (Codex)", true, false],
      ["claude", "subscription", "Claude", true, false],
      ["antigravity", "subscription", "Google", false, false],
      ["openai", "key", "OpenAI", true, false],
      ["anthropic", "key", "Anthropic", true, false],
      ["gemini", "key", "Gemini", true, false],
    ]);
    expect(list.find((c) => c.id === "codex")).toMatchObject({ login: "device", dialect: "responses" });
    const named = await backend("ollie", { providers: [{ id: "codex", name: "ChatGPT" }, "openai"] }).connections();
    expect(named.map((c) => [c.id, c.name])).toEqual([["codex", "ChatGPT"], ["openai", "OpenAI"]]);
  });

  it("signs in with the Codex device code, lists models and streams a chat", async () => {
    const b = backend("badger");
    await b.connections();
    const start = await b.startLogin!("codex");
    expect(start).toMatchObject({ kind: "device", code: "ABCD-1234", interval: 1 });
    expect(start.url).toMatch(/\/codex\/device$/);
    expect(await b.completeLogin!("codex")).toBe("pending");
    await steer({ approved: true });
    // the Go server throttles device polls to the vendor's interval on its own clock, in another process
    await new Promise((r) => setTimeout(r, 1100));
    expect(await b.completeLogin!("codex")).toBe("connected");
    expect((await b.connections()).find((c) => c.id === "codex")).toMatchObject({ connected: true, account: "al@example.com" });
    expect(await b.models("codex")).toEqual([{ id: "gpt-codex", name: "GPT Codex" }]);
    const res = await send(() => b.transport("codex")({ dialect: "responses", model: "gpt-codex", body: { model: "gpt-codex", input: [] } }));
    expect(await res.text()).toContain("response.output_text.delta");
    await b.logout!("codex");
    expect((await b.connections()).find((c) => c.id === "codex")?.connected).toBe(false);
    await steer({ approved: false });
  });

  it("signs in with a pasted Claude code and maps server errors to messages", async () => {
    const b = backend("heron", { message: (code, fallback) => (code === "validation" ? "Paste the whole code." : fallback) });
    await b.connections();
    const start = await b.startLogin!("claude");
    expect(start.kind).toBe("paste");
    const url = new URL(start.url);
    await steer({ challenge: url.searchParams.get("code_challenge")! });
    const empty = await failure(b.completeLogin!("claude", "   "));
    expect(empty).toMatchObject({ kind: "bad_request", code: "validation", message: "Paste the whole code.", status: 422 });
    expect(await b.completeLogin!("claude", `claude-code#${url.searchParams.get("state")}`)).toBe("connected");
    expect((await b.connections()).find((c) => c.id === "claude")).toMatchObject({ connected: true, account: "c@example.com" });
    const turnedOff = await failure(b.startLogin!("antigravity"));
    expect(turnedOff).toMatchObject({ kind: "auth", code: "oauth_disabled", status: 403 });
  });

  it("shows another browser's sign-in as not connected and asks it to sign in again", async () => {
    const owner = backend("otter", { headers: { "X-User": "otter", "X-Test-Key": "browser-1" } });
    await owner.connections();
    const start = await owner.startLogin!("claude");
    const url = new URL(start.url);
    await steer({ challenge: url.searchParams.get("code_challenge")! });
    expect(await owner.completeLogin!("claude", `claude-code#${url.searchParams.get("state")}`)).toBe("connected");

    const other = backend("otter", {
      headers: () => ({ "X-User": "otter", "X-Test-Key": "browser-2" }),
      connection: (c, st) => (st.key_match === false ? { ...c, note: "Signed in in another browser." } : c),
    });
    expect((await other.connections()).find((c) => c.id === "claude")).toMatchObject({ connected: false, account: undefined, note: "Signed in in another browser." });
    const res = await other.transport("claude")({ dialect: "messages", model: "claude-x", body: { model: "claude-x", messages: [] } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "oauth_key_mismatch" } });
    const models = await failure(other.models("claude"));
    expect(models).toMatchObject({ kind: "auth", code: "oauth_key_mismatch" });
  });

  it("verifies, stores and removes server-side API keys", async () => {
    const b = backend("stoat");
    await b.connections();
    const rejected = await failure(b.saveKey!("openai", "bad"));
    expect(rejected).toMatchObject({ kind: "bad_request", code: "invalid_key", status: 422 });
    await b.saveKey!("openai", "good");
    expect((await b.connections()).find((c) => c.id === "openai")?.connected).toBe(true);
    expect((await b.models("openai")).map((m) => m.id)).toEqual(["gpt-5", "o3", "gpt-4o"]);
    await b.saveKey!("openai", null);
    expect((await b.connections()).find((c) => c.id === "openai")?.connected).toBe(false);
    await expect(b.startLogin!("openai")).rejects.toThrow(/Unknown connection/);
  });
});
