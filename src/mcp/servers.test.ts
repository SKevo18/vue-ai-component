import { describe, expect, it, vi } from "vitest";
import type { McpClient } from "./client";
import { createMcpServers, failedServers } from "./servers";

function rpcFetch() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method !== "initialize") return new Response(null, { status: 202 });
    const result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "den" } };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
}

function resourceServer(scheme: string, read: McpClient["readResource"]): McpClient {
  return {
    url: `https://${scheme}.example/mcp`,
    info: null,
    connect: async () => ({ protocolVersion: "2025-06-18", capabilities: { resources: {} }, serverInfo: { name: scheme } }),
    listResourceTemplates: async () => [{ uriTemplate: `${scheme}://{id}`, name: scheme }],
    listResources: async () => [],
    readResource: read,
    callTool: vi.fn(),
  } as unknown as McpClient;
}

describe("MCP servers", () => {
  it("sends the browser tab header only to servers on the page's origin", async () => {
    const own = rpcFetch();
    const other = rpcFetch();
    const servers = createMcpServers({ app: { url: "/api/mcp", fetch: own }, docs: { url: "https://docs.example.com/mcp", fetch: other } }, () => ({ "X-Browser-Tab": "tab-1" }));
    await servers.clients.app!.connect();
    await servers.clients.docs!.connect();
    expect(new Headers(own.mock.calls[0]![1]!.headers).get("X-Browser-Tab")).toBe("tab-1");
    expect(new Headers(other.mock.calls[0]![1]!.headers).has("X-Browser-Tab")).toBe(false);
  });

  it("reads a resource from the server advertising its scheme, then falls back to the others in order", async () => {
    const den = vi.fn(async (uri: string) => [{ uri, text: "den" }]);
    const river = vi.fn(async (uri: string) => [{ uri, text: "river" }]);
    const servers = createMcpServers({ den: resourceServer("den", den), river: resourceServer("river", river) });
    expect(await servers.readResource("river://3")).toEqual([{ uri: "river://3", text: "river" }]);
    expect(den).not.toHaveBeenCalled();
    den.mockRejectedValueOnce(new Error("not found"));
    expect(await servers.readResource("pond://1")).toEqual([{ uri: "pond://1", text: "river" }]);
    expect(den).toHaveBeenCalledOnce();
  });

  it("rejects ids that cannot prefix a tool name", () => {
    expect(() => createMcpServers({ "my server": { url: "/mcp" } })).toThrow(/must be 1-32/);
  });

  it("names each server by its display name, falling back to the id", () => {
    const client = resourceServer("den", vi.fn());
    const servers = createMcpServers({ app: { url: "/api/mcp", name: "Docs" }, den: Object.assign(client, { name: "Den notes" }), river: { url: "/river" } });
    expect(servers.names).toEqual({ app: "Docs", den: "Den notes", river: "river" });
  });

  it("lists the failing servers with their names and raw errors", () => {
    expect(failedServers({ app: { name: "App", info: null, error: "" }, docs: { name: "Docs", info: null, error: "offline" } })).toEqual([{ id: "docs", name: "Docs", error: "offline" }]);
    expect(failedServers({ app: { name: "App", info: null, error: "" } })).toEqual([]);
  });
});
