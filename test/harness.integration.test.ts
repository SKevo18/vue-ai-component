// @vitest-environment node
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { createAi, type Ai } from "../src/ai";
import type { AiBackend } from "../src/backend/types";
import { createBrowserToolHost } from "../src/browser/tool-host";
import type { ConversationStore, StoredConversation } from "../src/stores/conversations";
import type { AiPreferences } from "../src/stores/preferences";
import { lastUser, scriptedTransport, toolOutputs, type FakeTurn, type ResponsesInputItem } from "./fake-provider";
import { FIXTURE_TOKEN, hasGo, startFixture, type Fixture } from "./fixture-server";

const go = hasGo();

function memoryStores() {
  const saved = new Map<string, StoredConversation>();
  let prefs: Partial<AiPreferences> = {};
  const conversations: ConversationStore = {
    list: async () => [...saved.values()].map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    load: async (id) => structuredClone(saved.get(id) ?? null),
    save: async (c) => void saved.set(c.id, structuredClone(c)),
    remove: async (id) => void saved.delete(id),
  };
  return { saved, conversations, preferences: { load: async () => prefs, save: async (p: AiPreferences) => void (prefs = p) } };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

function script(input: ResponsesInputItem[], body: Record<string, unknown>): FakeTurn {
  const user = lastUser(input);
  const outputs = toolOutputs(input).length;
  const sinceUser = input.length - 1 - [...input].reverse().findIndex((i) => i.role === "user");
  const fresh = toolOutputs(input.slice(sinceUser));
  if (user.startsWith("rename")) {
    if (!fresh.length) return { reasoning: "The user wants a new name.", calls: [{ name: "rename_burrow", args: { id: 2, name: "Fern Den" } }] };
    return { text: `Result: ${fresh.at(-1)} See burrow://2.` };
  }
  if (user.startsWith("big")) {
    if (fresh.length === 0) return { calls: [{ name: "read", args: { uri: "burrow://big" } }] };
    if (fresh.length === 1) return { calls: [{ name: "read", args: { uri: "burrow://big", offset: 40000 } }] };
    return { text: `Read ${fresh.map((f) => f.length).join(" and ")} characters.` };
  }
  if (user.startsWith("who")) {
    if (!fresh.length) return { calls: [{ name: "whoami", args: {} }] };
    return { text: fresh.at(-1)! };
  }
  if (user.startsWith("prompt")) return { text: String(body.instructions) };
  if (user.startsWith("cut")) return { text: "half an otter", truncated: true };
  return { text: `echo ${user} (${outputs} tool results so far)` };
}

describe.skipIf(!go)("harness run against the fixture server", () => {
  let fixture: Fixture;
  let ai: Ai;
  const stores = memoryStores();
  const host = createBrowserToolHost({ respond: () => undefined });
  const bodies: Record<string, unknown>[] = [];

  beforeAll(async () => {
    fixture = await startFixture();
    const transport = scriptedTransport((input, body) => {
      bodies.push(body);
      return script(input, body);
    });
    const backend: AiBackend = {
      connections: async () => [{ id: "otter", kind: "site", dialect: "responses", name: "Otter AI", connected: true, enabled: true }],
      models: async () => [{ id: "otter-1" }],
      transport: () => transport,
    };
    ai = createAi({
      backend,
      mcp: { burrows: { url: fixture.url, headers: () => ({ Authorization: `Bearer ${FIXTURE_TOKEN}` }) } },
      toolHost: host,
      conversations: stores.conversations,
      preferences: stores.preferences,
      context: [{ uri: "burrow://1", label: "Mossy Hollow" }],
      storagePrefix: "test:",
    });
    await ai.init();
  });
  afterAll(() => fixture?.stop());

  it("knows the MCP tool titles right after init, before any run", async () => {
    await waitFor(() => Object.keys(ai.state.toolTitles).length > 0);
    expect(ai.state.toolTitles).toEqual({ whoami: "Look at the burrow tab" });
  });

  it("asks before a write, runs it after approval and answers", async () => {
    const run = ai.send("rename burrow 2");
    await waitFor(() => ai.state.approval !== null);
    expect(ai.state.approval).toMatchObject({ tool: "rename_burrow", approval: "ask", args: { id: 2, name: "Fern Den" } });
    ai.decide("approve");
    await run;
    const last = ai.state.entries.at(-1)!;
    expect(last).toMatchObject({ role: "assistant", content: "Result: Renamed burrow 2 to Fern Den. See burrow://2." });
    expect(ai.state.entries[0]).toMatchObject({ role: "user", resources: [{ uri: "burrow://1" }] });
    expect(ai.state.title).toBe("rename burrow 2");
    expect(stores.saved.get(ai.state.conversationId)?.entries.length).toBe(ai.state.entries.length);
  });

  it("remembers 'always' for the chat and reports a denial to the model", async () => {
    await ai.newChat();
    const first = ai.send("rename again");
    await waitFor(() => ai.state.approval !== null);
    ai.decide("always");
    await first;
    expect(ai.state.allowedTools).toEqual(["rename_burrow"]);
    await ai.send("rename once more");
    expect(ai.state.approval).toBeNull();
    expect(ai.state.entries.filter((e) => e.role === "tool" && e.status === "done")).toHaveLength(2);

    await ai.newChat();
    const denied = ai.send("rename please");
    await waitFor(() => ai.state.approval !== null);
    ai.decide("deny");
    await denied;
    const tool = ai.state.entries.find((e) => e.role === "tool")!;
    expect(tool).toMatchObject({ status: "rejected", isError: true });
    expect(ai.state.entries.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining("rejected this action") });
  });

  it("reads a long resource in chunks through MCP", async () => {
    await ai.newChat();
    await ai.send("big read");
    expect(ai.state.entries.at(-1)).toMatchObject({ content: expect.stringMatching(/^Read \d+ and \d+ characters\.$/) });
    const reads = ai.state.entries.filter((e) => e.role === "tool");
    expect(reads[0]!.content).toContain("Continue with offset=40000");
  });

  it("sends the browser tab header to the MCP server", async () => {
    await ai.newChat();
    await ai.send("who am i");
    expect(JSON.parse((ai.state.entries.at(-1) as { content: string }).content)).toMatchObject({ tab: host.tabId });
  });

  it("builds the system prompt from server instructions, templates and skills", async () => {
    await ai.newChat();
    await ai.send("prompt");
    const prompt = (ai.state.entries.at(-1) as { content: string }).content;
    expect(prompt).toContain("You manage the badger burrow registry of Otterfield.");
    expect(prompt).toContain("burrow://{id}: A burrow record as markdown");
    expect(prompt).toContain("attachment://{id}");
    expect(prompt).toContain("burrow-care: How to inspect and repair badger burrows. Use when a burrow is damaged. (skill://burrow-care/SKILL.md)");
    expect(prompt).toContain("visiting: Etiquette for otters visiting badger burrows. (skill://otters/visiting/SKILL.md)");
    const tools = (bodies.at(-1)!.tools as { name: string }[]).map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["read", "update_plan", "rename_burrow", "send_postcard"]));
  });

  it("stops a run and keeps the conversation consistent", async () => {
    await ai.newChat();
    const run = ai.send("rename to stop");
    await waitFor(() => ai.state.approval !== null);
    ai.stop();
    await run;
    await nextTick();
    expect(ai.state.running).toBe(false);
    expect(ai.state.error).toBeNull();
    expect(ai.state.entries.find((e) => e.role === "tool")).toMatchObject({ isError: true });
  });

  it("reports when the output limit cut a one-shot answer off", async () => {
    expect(await ai.completeResult("translate", "cut this short")).toEqual({ text: "half an otter", truncated: true });
    expect(await ai.completeResult("translate", "otters")).toMatchObject({ truncated: false });
  });

  it("lists the files the user attached to the chat with their bytes", async () => {
    await ai.newChat();
    await ai.attachText("Mossy Hollow: 3 badgers", "census.txt");
    await ai.send("echo the census");
    await ai.attachText("Clover Den: 5 badgers", "draft.txt");
    const files = await ai.files();
    expect(files.map((f) => [f.name, f.mimeType, f.size])).toEqual([
      ["census.txt", "text/plain", 23],
      ["draft.txt", "text/plain", 21],
    ]);
    expect(await files[0]!.blob.text()).toBe("Mossy Hollow: 3 badgers");
    expect(files[0]!.uri).toMatch(/^attachment:\/\//);
  });

  it("exports a chat as JSON with entries, prompt and tool definitions", async () => {
    await ai.newChat();
    await ai.send("echo for export");
    const { filename, json } = await ai.exportConversation();
    const data = JSON.parse(json);
    expect(filename).toMatch(/^ai-conversation-\d{8}-\d{6}-[\w-]{8}\.json$/);
    expect(data).toMatchObject({ format: "vue-ai-component-conversation", version: 2, conversation: { id: ai.state.conversationId, title: "echo for export", connection: "otter" }, mcp: { burrows: { protocol: expect.any(String) } } });
    expect(data.system).toContain("badger burrow registry");
    expect(data.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["read", "rename_burrow"]));
    expect(data.entries.map((e: { role: string }) => e.role)).toEqual(["user", "assistant"]);
    const older = stores.saved.keys().next().value!;
    expect(JSON.parse((await ai.exportConversation(older)).json).conversation.id).toBe(older);
  });

  it("deletes every chat at once", async () => {
    expect(stores.saved.size).toBeGreaterThan(1);
    await ai.removeAllChats();
    expect(stores.saved.size).toBe(0);
    expect(ai.state.history).toEqual([]);
    expect(ai.state.entries).toEqual([]);
  });

  it("completes one-shot prompts without tools", async () => {
    const before = bodies.length;
    expect(await ai.complete("summarise", "otters hold paws")).toBe("echo otters hold paws (0 tool results so far)");
    expect(bodies[before]!.tools).toBeUndefined();
  });
});

describe.skipIf(!go)("harness run against two MCP servers", () => {
  let fixture: Fixture;
  let ai: Ai;

  beforeAll(async () => {
    fixture = await startFixture();
    const headers = () => ({ Authorization: `Bearer ${FIXTURE_TOKEN}` });
    const transport = scriptedTransport((input, body) => {
      const user = lastUser(input);
      const sinceUser = input.length - 1 - [...input].reverse().findIndex((i) => i.role === "user");
      const fresh = toolOutputs(input.slice(sinceUser));
      if (user.startsWith("rename")) return fresh.length ? { text: `Result: ${fresh.at(-1)}` } : { calls: [{ name: "river__rename_burrow", args: { id: 3, name: "Reed Den" } }] };
      return { text: String(body.instructions) };
    });
    const stores = memoryStores();
    ai = createAi({
      backend: {
        connections: async () => [{ id: "otter", kind: "site", dialect: "responses", name: "Otter AI", connected: true, enabled: true }],
        models: async () => [{ id: "otter-1" }],
        transport: () => transport,
      },
      mcp: { den: { url: fixture.url, headers }, river: { url: fixture.url, headers } },
      conversations: stores.conversations,
      preferences: stores.preferences,
      storagePrefix: "multi:",
    });
    await ai.init();
  });
  afterAll(() => fixture?.stop());

  it("prefixes the tools both servers offer and runs a prefixed call", async () => {
    const names = (await ai.tools()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["den__rename_burrow", "river__rename_burrow", "read"]));
    expect(names).not.toContain("rename_burrow");
    const run = ai.send("rename burrow 3");
    await waitFor(() => ai.state.approval !== null);
    expect(ai.state.approval).toMatchObject({ tool: "river__rename_burrow", args: { id: 3, name: "Reed Den" } });
    ai.decide("approve");
    await run;
    expect(ai.state.entries.at(-1)).toMatchObject({ role: "assistant", content: "Result: Renamed burrow 3 to Reed Den." });
    expect(ai.state.mcp).toMatchObject({ den: { error: "" }, river: { error: "" } });
  });

  it("puts each server's instructions under its id and reads resources from either", async () => {
    await ai.newChat();
    await ai.send("prompt");
    const prompt = (ai.state.entries.at(-1) as { content: string }).content;
    expect(prompt).toContain("## den\nYou manage the badger burrow registry of Otterfield.");
    expect(prompt).toContain("## river\nYou manage the badger burrow registry of Otterfield.");
    expect((await ai.read("burrow://1")).text).toContain("Mossy Hollow");
  });
});
