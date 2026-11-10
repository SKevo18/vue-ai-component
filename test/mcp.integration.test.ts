// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpClient, type McpClient } from "../src/mcp/client";
import { mcpHarnessTool, toolApproval } from "../src/mcp/tools";
import { McpError, type McpContent } from "../src/mcp/types";
import { FIXTURE_TOKEN, hasGo, startFixture, type Fixture } from "./fixture-server";

const go = hasGo();
if (!go) console.warn("skipping MCP integration tests: `go` is not installed, so the fixture server cannot be built");

describe.skipIf(!go)("MCP client against the Go fixture server", () => {
  let fixture: Fixture;
  let requests: { method: string; headers: Headers }[];

  const client = (headers: Record<string, string> = {}): McpClient =>
    createMcpClient({
      url: fixture.url,
      headers: () => ({ Authorization: `Bearer ${FIXTURE_TOKEN}`, ...headers }),
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        requests.push({ method: body.method ?? "", headers: new Headers(init?.headers) });
        return fetch(input, init);
      },
    });

  beforeAll(async () => {
    fixture = await startFixture();
  });
  afterAll(() => fixture?.stop());

  it("initializes once with instructions and sends the protocol version afterwards", async () => {
    requests = [];
    const c = client();
    const info = await c.connect();
    expect(info.protocolVersion).toBe("2025-11-25");
    expect(info.serverInfo.name).toBe("burrow-registry");
    expect(info.instructions).toContain("badger burrow registry of Otterfield");
    await c.connect();
    await c.listTools();
    expect(requests.map((r) => r.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/list"]);
    expect(requests[0]!.headers.get("MCP-Protocol-Version")).toBeNull();
    expect(requests[2]!.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
    expect(requests[2]!.headers.get("Accept")).toBe("application/json, text/event-stream");
  });

  it("lists every tool across pages, caches the list and refreshes on demand", async () => {
    requests = [];
    const c = client();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["burrow_link", "burrow_photo", "dig_tunnel", "explode", "fill_burrow", "list_burrows", "progress_dig", "rename_burrow", "send_postcard", "slow_dig", "whoami"]);
    await c.listTools();
    expect(requests.filter((r) => r.method === "tools/list")).toHaveLength(3);
    await c.listTools({ refresh: true });
    expect(requests.filter((r) => r.method === "tools/list")).toHaveLength(6);
    const approval = Object.fromEntries(tools.map((t) => [t.name, toolApproval(t)]));
    expect(approval).toMatchObject({ list_burrows: "auto", rename_burrow: "ask", fill_burrow: "confirm", send_postcard: "confirm", dig_tunnel: "auto" });
  });

  it("calls tools and returns text, tool errors, images and resource links", async () => {
    const c = client();
    const list = await c.callTool("list_burrows", { q: "den" });
    expect(list.content).toEqual([{ type: "text", text: '[{"id":2,"name":"Clover Den","badgers":5}]' }]);
    expect(list.structuredContent).toEqual({ burrows: [{ id: 2, name: "Clover Den", badgers: 5 }] });
    expect(await c.callTool("rename_burrow", { id: 7, name: "Heron Hall" })).toMatchObject({ isError: true, content: [{ type: "text", text: "No burrow 7." }] });
    const photo = await c.callTool("burrow_photo", { id: 1 });
    const image = photo.content.find((i): i is Extract<McpContent, { type: "image" }> => i.type === "image")!;
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect((await c.callTool("burrow_link", { id: 1 })).content).toEqual([{ type: "resource_link", uri: "burrow://1", name: "burrow-1", title: "Mossy Hollow", mimeType: "text/markdown" }]);
    expect(await c.callTool("explode", {})).toMatchObject({ isError: true, content: [{ text: "the burrow collapsed" }] });
  });

  it("runs MCP tools as harness tools, storing images through the context", async () => {
    const c = client();
    const tool = mcpHarnessTool((await c.listTools()).find((t) => t.name === "burrow_photo")!, c, "burrows");
    const saved: string[] = [];
    const result = await tool.run({ id: 2 }, { signal: new AbortController().signal, conversationId: "c", saveImage: async (img) => (saved.push(img.mimeType), { uri: "attachment://photo" }) });
    expect(tool.readOnly).toBe(true);
    expect(saved).toEqual(["image/png"]);
    expect(result).toMatchObject({ images: [{ uri: "attachment://photo" }] });
    expect(result.text).toContain("Photo of burrow 2.");
  });

  it("surfaces JSON-RPC errors for unknown tools", async () => {
    const err = await client().callTool("summon_heron", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ kind: "rpc" });
    expect((err as McpError).message).toMatch(/summon_heron/);
  });

  it("sends the app's extra headers with every request", async () => {
    const whoami = await client({ "X-Browser-Tab": "tab-otter", "X-Otter": "ollie" }).callTool("whoami", {});
    expect(JSON.parse((whoami.content[0] as { text: string }).text)).toEqual({ tab: "tab-otter", otter: "ollie" });
  });

  it("sends a progress token and reports progress streamed over SSE", async () => {
    requests = [];
    const c = createMcpClient({
      url: fixture.url.replace(/\/mcp$/, "/mcp-sse"),
      headers: () => ({ Authorization: `Bearer ${FIXTURE_TOKEN}` }),
      fetch: async (input, init) => {
        requests.push({ method: JSON.parse(String(init?.body)).method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) } as never);
        return fetch(input, init);
      },
    });
    const seen: { progress: number; total?: number; message?: string }[] = [];
    const result = await c.callTool("progress_dig", { steps: 3, ms: 30 }, { onProgress: (p) => seen.push(p) });
    expect(result.content).toEqual([{ type: "text", text: "Dug 3 steps (token true)." }]);
    expect(seen).toEqual([1, 2, 3].map((progress) => ({ progress, total: 3, message: `dug ${progress} of 3` })));
    const call = requests.find((r) => r.method === "tools/call") as unknown as { body: { params: { _meta: { progressToken: string } } } };
    expect(call.body.params._meta.progressToken).toMatch(/^call-/);
  });

  it("runs MCP tools as harness tools and shows progress as activity", async () => {
    const c = createMcpClient({ url: fixture.url.replace(/\/mcp$/, "/mcp-sse"), headers: () => ({ Authorization: `Bearer ${FIXTURE_TOKEN}` }) });
    const tool = mcpHarnessTool((await c.listTools()).find((t) => t.name === "progress_dig")!, c, "burrows");
    const messages: string[] = [];
    await tool.run({ steps: 2, ms: 20 }, { signal: new AbortController().signal, conversationId: "c", saveImage: async () => ({ uri: "attachment://x" }), onProgress: (m) => messages.push(m) });
    expect(messages).toEqual(["dug 1 of 2", "dug 2 of 2"]);
  });

  it("aborts a running call", async () => {
    const controller = new AbortController();
    const pending = client().callTool("slow_dig", { ms: 5000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("lists resources and templates across pages and reads text and blobs", async () => {
    const c = client();
    const resources = await c.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["skill://burrow-care/SKILL.md", "skill://otters/visiting/SKILL.md", "docs://registry-guide", "docs://tunnel-rules", "docs://postcards", "note://otterfield-minutes"]),
    );
    expect(resources.find((r) => r.uri === "skill://burrow-care/SKILL.md")).toMatchObject({ name: "burrow-care", mimeType: "text/markdown", description: expect.stringContaining("damaged") });
    const templates = await c.listResourceTemplates();
    expect(templates.map((t) => t.uriTemplate).sort()).toEqual(["burrow://{id}", "photo://{name}"]);
    expect(await c.readResource("burrow://1")).toEqual([{ uri: "burrow://1", mimeType: "text/markdown", text: "# Mossy Hollow\n\nBadgers: 3\n" }]);
    const [photo] = await c.readResource("photo://den.png");
    expect(photo).toMatchObject({ uri: "photo://den.png", mimeType: "image/png" });
    expect("blob" in photo! && photo.blob.length).toBeGreaterThan(20);
  });

  it("reports a missing resource as a JSON-RPC error", async () => {
    const err = await client().readResource("burrow://nope").catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rpc", code: -32602 });
  });

  it("reports a missing token as an HTTP 401", async () => {
    const c = createMcpClient({ url: fixture.url });
    await expect(c.listTools()).rejects.toMatchObject({ kind: "http", status: 401 });
  });
});
