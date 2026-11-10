// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { componentAi } from "../test/component-ai";
import type { McpClient } from "./mcp/client";

describe("resource preview API", () => {
  it("keeps nonattachment clicks on the app route and previews namespace resources only on explicit opt-in", async () => {
    const route = vi.fn();
    const ai = componentAi({ openResource: route });
    ai.openResource("note://den");
    expect(route).toHaveBeenCalledWith("note://den");
    expect(ai.state.preview).toBeNull();
    ai.previewResource("note://den");
    expect(ai.state.preview?.uri).toBe("note://den");
    expect(route).toHaveBeenCalledTimes(1);
    ai.closePreview();
    expect(ai.state.preview).toBeNull();
  });

  it("previews stored attachments without provider calls and preserves original bytes and sizes after sending", async () => {
    const transport = vi.fn(() => async () => new Response("", { status: 500 }));
    const ai = componentAi({ storagePrefix: "preview-api:" }, { transport });
    await ai.init();
    const ref = await ai.attachText("otter notes", "notes.txt");
    expect(ref).toMatchObject({ label: "notes.txt", size: 11 });
    ai.openResource(ref!.uri);
    await vi.waitFor(() => expect(ai.state.preview?.original?.size).toBe(11));
    expect(await ai.state.preview!.original!.blob.text()).toBe("otter notes");
    expect(await ai.read(ref!.uri)).toMatchObject({ text: "otter notes" });
    expect(transport).not.toHaveBeenCalled();
    await ai.send("Read the attachment");
    const sent = ai.state.entries.find((e) => e.role === "user");
    expect(sent?.role === "user" && sent.resources).toEqual([ref]);
    await ai.newChat();
    expect(ai.state.preview).toBeNull();
  });

  it("does not resurrect attachment metadata if its lookup finishes after closing", async () => {
    const ai = componentAi({ storagePrefix: "preview-close:" });
    const ref = await ai.attachText("notes", "notes.txt");
    ai.openResource(ref!.uri);
    ai.closePreview();
    await ai.read(ref!.uri);
    expect(ai.state.preview).toBeNull();
  });

  it("propagates picker failures instead of reporting an empty successful search", async () => {
    const ai = componentAi({ searchResources: async () => { throw new Error("Search unavailable"); } });
    await expect(ai.pickerItems("den", new AbortController().signal)).rejects.toThrow("Search unavailable");
    const mcp = { callTool: vi.fn(), connect: async () => ({ capabilities: { resources: {} } }), listResources: async () => { throw new Error("Resources unavailable"); } } as unknown as McpClient;
    await expect(componentAi({ mcp: { den: mcp } }).pickerItems("", new AbortController().signal)).rejects.toThrow("Resources unavailable");
  });

  it("preserves optional size metadata on custom picker results", async () => {
    const ai = componentAi({ searchResources: async () => [{ uri: "note://den", label: "Den", size: 2048 }] });
    expect(await ai.pickerItems("den", new AbortController().signal)).toContainEqual({ uri: "note://den", label: "Den", size: 2048, group: "results" });
  });
});
