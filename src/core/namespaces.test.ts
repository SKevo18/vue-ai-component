import { describe, expect, it, vi } from "vitest";
import type { McpClient } from "../mcp/client";
import { formatRead } from "./builtins";
import { createNamespaceRegistry, READ_LIMIT, textChunk } from "./namespaces";

function fakeMcp(contents: Record<string, { text?: string; blob?: string; mimeType?: string }>) {
  const readResource = vi.fn(async (uri: string) => {
    const c = contents[uri];
    if (!c) throw new Error(`Resource not found: ${uri}`);
    return [{ uri, ...c } as { uri: string; text: string }];
  });
  return { client: { readResource } as unknown as McpClient, readResource };
}

describe("textChunk", () => {
  it("never splits a surrogate pair", () => {
    const text = "ab\u{1F9A6}cd";
    expect(textChunk(text, 0, 3)).toEqual({ text: "ab", offset: 0, totalChars: 6, nextOffset: 2 });
    expect(() => textChunk(text, 3, 2)).toThrow(/splits a character/);
    expect(textChunk(text, 2, 10)).toEqual({ text: "\u{1F9A6}cd", offset: 2, totalChars: 6 });
  });
});

describe("namespace registry", () => {
  it("reads long MCP text in chunks with the next offset", async () => {
    const big = "otter ".repeat(10000);
    const { client, readResource } = fakeMcp({ "burrow://big": { text: big, mimeType: "text/plain" } });
    const registry = createNamespaceRegistry({ mcp: client, prepareImage: async (i) => i });
    const first = await registry.read("burrow://big");
    expect(first.text).toHaveLength(READ_LIMIT);
    expect(first.nextOffset).toBe(READ_LIMIT);
    expect(formatRead(first)).toContain(`Continue with offset=${READ_LIMIT}`);
    const second = await registry.read("burrow://big", { offset: first.nextOffset });
    expect(second.text).toBe(big.slice(READ_LIMIT, 2 * READ_LIMIT));
    expect(readResource).toHaveBeenCalledOnce();
  });

  it("routes local schemes to the registered namespace", async () => {
    const { client, readResource } = fakeMcp({});
    const registry = createNamespaceRegistry({ mcp: client, prepareImage: async (i) => i });
    const remove = registry.register({ scheme: "den", template: "den://{name}", description: "dens", read: async (uri) => ({ text: `inside ${uri}` }) });
    expect((await registry.read("den://mossy")).text).toBe("inside den://mossy");
    remove();
    await expect(registry.read("den://mossy")).rejects.toThrow(/not found/);
    expect(readResource).toHaveBeenCalledOnce();
  });

  it("returns MCP image blobs as visual input", async () => {
    const { client } = fakeMcp({ "photo://den.png": { blob: "iVBORotter", mimeType: "image/png" } });
    const prepared = vi.fn(async (i: { mimeType: string; data: string }) => ({ mimeType: "image/jpeg", data: `jpeg(${i.data})` }));
    const registry = createNamespaceRegistry({ mcp: client, prepareImage: prepared });
    const r = await registry.read("photo://den.png");
    expect(r.image).toEqual({ uri: "photo://den.png" });
    expect(r.text).toBeUndefined();
    expect(await registry.image({ uri: "photo://den.png" })).toEqual({ mimeType: "image/jpeg", data: "jpeg(iVBORotter)" });
  });

  it("keeps a bounded number of MCP images and reads evicted ones again", async () => {
    const photos = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`photo://${i}`, { blob: `img${i}`, mimeType: "image/png" }]));
    const { client, readResource } = fakeMcp(photos);
    const registry = createNamespaceRegistry({ mcp: client, prepareImage: async (i) => i });
    for (let i = 0; i < 17; i++) await registry.read(`photo://${i}`);
    expect(await registry.image({ uri: "photo://16" })).toEqual({ mimeType: "image/png", data: "img16" });
    expect(readResource).toHaveBeenCalledTimes(17);
    expect(await registry.image({ uri: "photo://0" })).toEqual({ mimeType: "image/png", data: "img0" });
    expect(readResource).toHaveBeenCalledTimes(18);
  });

  it("decodes text blobs and describes binary ones", async () => {
    const { client } = fakeMcp({ "note://a": { blob: btoa("badger notes"), mimeType: "text/plain" }, "file://z": { blob: "AAAA", mimeType: "application/zip" } });
    const registry = createNamespaceRegistry({ mcp: client, prepareImage: async (i) => i });
    expect((await registry.read("note://a")).text).toBe("badger notes");
    expect((await registry.read("file://z")).text).toContain("Binary content (application/zip), 3 bytes");
  });

  it("rejects text that is not a URI and pages on non-PDF resources", async () => {
    const { client } = fakeMcp({ "burrow://1": { text: "# Mossy Hollow" } });
    const registry = createNamespaceRegistry({ mcp: client, prepareImage: async (i) => i });
    await expect(registry.read("mossy hollow")).rejects.toThrow(/not a URI/);
    await expect(registry.read("burrow://1", { page: 2 })).rejects.toThrow(/Only PDF/);
    await expect(registry.read("burrow://1", { limit: 0 })).rejects.toThrow(/limit must be/);
  });
});
