import { describe, expect, it, vi } from "vitest";
import { responsesEvents, sseResponse } from "../../test/fake-provider";
import { createBrowserKeys, mergeBackends } from "../backend/browser-keys";
import type { AiBackend } from "../backend/types";
import { parseStream } from "../core/sse";
import type { ChatRequest } from "../core/types";
import { GenerateStream, generateBody, toGeminiSchema } from "./generate";
import { connectionChat } from "./index";
import { MessagesStream, messagesBody } from "./messages";
import { ResponsesStream, responsesBody } from "./responses";

const req: ChatRequest = {
  model: "otter-large",
  system: "be brief",
  cacheKey: "conv-1",
  tools: [{ name: "count_badgers", description: "Counts badgers", parameters: { type: "object", properties: { den: { type: ["string", "null"] }, filters: { type: "object" } }, required: ["den"] } }],
  messages: [
    { role: "user", content: "how many?", images: [{ mimeType: "image/jpeg", data: "QUJD" }] },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "count_badgers", args: { den: "mossy" } }], meta: { reasoning: [{ type: "reasoning", id: "rs1", summary: [], encrypted_content: "x" }] } },
    { role: "tool", toolCallId: "c1", name: "count_badgers", content: "3" },
  ],
};

describe("responses dialect", () => {
  it("builds the body with images, replayed reasoning and an optional tool namespace", () => {
    const body = responsesBody(req, { toolNamespace: "burrows", reasoning: true });
    const input = body.input as Record<string, unknown>[];
    expect(input[0]).toMatchObject({ role: "user", content: [{ type: "input_text" }, { type: "input_image", image_url: "data:image/jpeg;base64,QUJD" }] });
    expect(input[1]).toMatchObject({ type: "reasoning", id: "rs1" });
    expect(input.at(-1)).toEqual({ type: "function_call_output", call_id: "c1", output: "3" });
    expect(body.tools).toMatchObject([{ type: "namespace", name: "burrows", tools: [{ name: "count_badgers" }] }]);
    expect(body).toMatchObject({ prompt_cache_key: "conv-1", store: false, reasoning: { effort: "medium" } });
  });

  it("parses a stream into text, calls, reasoning items and usage", async () => {
    const res = await parseStream(sseResponse(responsesEvents({ reasoning: "hmm", text: "Counting otters now.", calls: [{ name: "burrows.count_badgers", args: { den: "clover" } }] })), new ResponsesStream("burrows"));
    expect(res.text).toBe("Counting otters now.");
    expect(res.toolCalls).toMatchObject([{ name: "count_badgers", args: { den: "clover" } }]);
    expect(res.meta).toMatchObject({ reasoning: [{ type: "reasoning", encrypted_content: "badger-secret" }] });
    expect(res.usage).toEqual({ input: 120, output: 30, cached: 80 });
  });

  it("marks replies cut off by the output limit", async () => {
    const res = await parseStream(sseResponse(responsesEvents({ text: "half", truncated: true })), new ResponsesStream());
    expect(res.truncated).toBe(true);
  });
});

describe("messages dialect", () => {
  it("merges tool results into user turns and sets cache breakpoints", () => {
    const body = messagesBody({ ...req, model: "claude-sonnet-4-5" });
    const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!.content[1]).toMatchObject({ type: "image", source: { data: "QUJD" } });
    expect(messages.at(-1)!.content.at(-1)).toMatchObject({ type: "tool_result", cache_control: { type: "ephemeral" } });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("parses tool use and thinking with its signature", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "badgers..." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "count_badgers" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"den":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"mossy"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    ];
    const res = await parseStream(sseResponse(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")), new MessagesStream());
    expect(res.toolCalls).toEqual([{ id: "tu1", name: "count_badgers", args: { den: "mossy" } }]);
    expect(res.meta).toEqual({ thinking: [{ type: "thinking", thinking: "badgers...", signature: "sig" }] });
    expect(res.usage).toEqual({ input: 100, output: 7, cached: 90 });
  });
});

describe("generate dialect", () => {
  it("converts MCP schemas to the Gemini subset", () => {
    expect(toGeminiSchema({ type: "object", properties: { den: { type: ["string", "null"] }, size: { anyOf: [{ type: "integer" }, { type: "null" }] }, kind: { type: "integer", enum: [1, 2] }, extra: { type: "object" } } })).toEqual({
      type: "OBJECT",
      properties: { den: { type: "STRING", nullable: true }, size: { type: "INTEGER", nullable: true }, kind: { type: "INTEGER" }, extra: { type: "STRING", description: "(JSON object text)" } },
    });
    expect(generateBody(req).tools).toMatchObject([{ functionDeclarations: [{ name: "count_badgers", parameters: { required: ["den"] } }] }]);
  });

  it("unwraps chunks a proxy wrapped and keeps thought signatures", async () => {
    const chunk = { response: { candidates: [{ content: { parts: [{ text: "pondering", thought: true }, { functionCall: { name: "count_badgers", args: { den: "rooty" } }, thoughtSignature: "ts1" }] } }] } };
    const res = await parseStream(sseResponse(`data: ${JSON.stringify(chunk)}\n\n`), new GenerateStream());
    expect(res.reasoning).toBe("pondering");
    expect(res.toolCalls[0]).toMatchObject({ name: "count_badgers", args: { den: "rooty" }, meta: { thoughtSignature: "ts1" } });
  });
});

describe("connections", () => {
  it("maps HTTP errors of the transport to error kinds", async () => {
    const chat = connectionChat({ dialect: "responses" }, async () => new Response(JSON.stringify({ error: { message: "slow down, otter" } }), { status: 429 }));
    await expect(chat(req)).rejects.toMatchObject({ kind: "rate_limit", message: "slow down, otter" });
  });

  it("calls vendors directly with browser keys; Gemini takes the model in the URL", async () => {
    const storage = new Map<string, string>();
    const fakeStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) } as Storage;
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/v1beta/models?")) return Response.json({ models: [{ name: "models/gemini-2.5-flash", displayName: "Flash", supportedGenerationMethods: ["generateContent"] }] });
      return sseResponse("");
    });
    const keys = createBrowserKeys({ storage: fakeStorage, fetch: fetch as typeof globalThis.fetch, prefix: "t:" });
    await keys.saveKey("gemini", "  AIza-badger-key-123456  ");
    expect(storage.get("t:key:gemini")).toBe("AIza-badger-key-123456");
    expect((await keys.connections()).find((c) => c.id === "gemini")).toMatchObject({ connected: true, account: "AIz...3456" });
    await keys.transport("gemini")({ dialect: "generate", model: "gemini-2.5-flash", body: { model: "gemini-2.5-flash", contents: [] } });
    const [url, init] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(JSON.parse(String(init.body))).toEqual({ contents: [] });
    expect(init.headers).toMatchObject({ "x-goog-api-key": "AIza-badger-key-123456" });
  });

  it("refuses a key the vendor rejects and keeps none", async () => {
    const storage = new Map<string, string>();
    const fakeStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) } as Storage;
    const keys = createBrowserKeys({ storage: fakeStorage, fetch: (async () => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 })) as typeof globalThis.fetch });
    await expect(keys.saveKey("anthropic", "sk-ant-otter")).rejects.toMatchObject({ kind: "auth" });
    expect(storage.size).toBe(0);
  });

  it("routes merged backends by connection id", async () => {
    const server: AiBackend = {
      connections: async () => [{ id: "otter-plan", kind: "subscription", dialect: "responses", name: "Otter plan", connected: true, enabled: true }],
      models: async () => [{ id: "gpt-otter" }],
      transport: () => async () => sseResponse("server"),
      startLogin: async () => ({ kind: "device", url: "https://otters.example/device", code: "OTTR-1234", interval: 5 }),
    };
    const browser: AiBackend = {
      connections: async () => [{ id: "openai", kind: "key", dialect: "responses", name: "OpenAI", connected: false, enabled: true }],
      models: async () => [{ id: "gpt-badger" }],
      transport: () => async () => sseResponse("browser"),
    };
    const merged = mergeBackends(server, browser);
    expect((await merged.models("openai"))[0]!.id).toBe("gpt-badger");
    expect(await (await merged.transport("otter-plan")({ dialect: "responses", model: "m", body: {} })).text()).toBe("server");
    expect(await merged.startLogin!("otter-plan")).toMatchObject({ code: "OTTR-1234" });
    await expect(merged.startLogin!("openai")).rejects.toThrow(/no sign-in/);
  });
});
