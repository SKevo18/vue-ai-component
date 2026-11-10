import { flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { initialApprovalPreview, loadApprovalPreview, parseApprovalPreview, type ApprovalPreview, type ApprovalPreviewContext, type ApprovalPreviewState } from "./approval";
import type { HarnessTool } from "./tools";
import type { McpClient } from "../mcp/client";
import { mcpHarnessTool } from "../mcp/tools";

const tool: HarnessTool = { name: "paint_badger", title: "Paint badger", description: "", approval: "ask", parameters: {}, readOnly: false, run: vi.fn() };

describe("approval previews", () => {
  it("accepts arbitrary MCP tool metadata and schema field labels without app tool names", () => {
    const client = {} as McpClient;
    const harness = mcpHarnessTool({ name: "paint_badger", inputSchema: { properties: { color: { type: "string", title: "Coat colour" } } }, _meta: { approvalPreview: { summary: "A blue sett", categoryHint: "Private painting" } } }, client);
    expect(initialApprovalPreview(harness, { color: "blue" })).toEqual({ summary: "A blue sett", categoryHint: "Private painting", fields: [{ label: "Coat colour", value: "blue" }] });
    expect(parseApprovalPreview({ before: {}, fields: [{ label: "badger", value: {} }, { label: "otter", value: "wet" }] })).toEqual({ fields: [{ label: "otter", value: "wet" }] });
  });

  it("only permits explicitly read-only MCP tool calls, not auto-approved writes or unknown tools", async () => {
    const callTool = vi.fn(async () => ({ content: [], structuredContent: { text: "badgers" } }));
    const client = { listTools: vi.fn(async () => [{ name: "peek", annotations: { readOnlyHint: true } }, { name: "dig", _meta: { approval: "auto" } }]), callTool } as unknown as McpClient;
    const state: ApprovalPreviewState = {};
    loadApprovalPreview(state, async ({ readTool }) => {
      await expect(readTool("dig", {})).rejects.toThrow("non-read-only");
      await expect(readTool("unknown", {})).rejects.toThrow("non-read-only");
      const result = await readTool("peek", { id: 3 });
      return { before: JSON.stringify(result.structuredContent), after: "otters" };
    }, tool, {}, client, new AbortController().signal, () => true);
    await flushPromises();
    expect(callTool).toHaveBeenCalledExactlyOnceWith("peek", { id: 3 }, { signal: expect.any(AbortSignal) });
    expect(state).toMatchObject({ previewLoading: false, preview: { before: '{"text":"badgers"}', after: "otters" } });
    expect(tool.run).not.toHaveBeenCalled();
  });

  it("reads resources through MCP with the preview cancellation signal", async () => {
    const readResource = vi.fn(async () => [{ uri: "sett://3", text: "old" }]);
    const client = { readResource } as unknown as McpClient;
    const state: ApprovalPreviewState = {};
    loadApprovalPreview(state, async (context) => ({ before: JSON.stringify(await context.readResource("sett://3")), after: "new" }), tool, {}, client, new AbortController().signal, () => true);
    await flushPromises();
    expect(readResource).toHaveBeenCalledExactlyOnceWith("sett://3", { signal: expect.any(AbortSignal) });
    expect(state.previewError).toBeUndefined();
  });

  it("aborts pending reads and ignores a late preview after a decision", async () => {
    const deferred = Promise.withResolvers<ApprovalPreview>();
    let context!: ApprovalPreviewContext;
    const state: ApprovalPreviewState = {};
    const cancel = loadApprovalPreview(state, (value) => { context = value; return deferred.promise; }, tool, {}, null, new AbortController().signal, () => true);
    await flushPromises();
    cancel();
    expect(context.signal.aborted).toBe(true);
    deferred.resolve({ before: "old", after: "wrong chat" });
    await flushPromises();
    expect(state.preview).toBeUndefined();
    expect(state.previewError).toBeUndefined();
  });

  it("ignores success and failure from a stale approval even if a hook ignores cancellation", async () => {
    const deferred = Promise.withResolvers<ApprovalPreview>();
    let current = true;
    const state: ApprovalPreviewState = {};
    loadApprovalPreview(state, () => deferred.promise, tool, {}, null, new AbortController().signal, () => current);
    await flushPromises();
    current = false;
    deferred.reject(new Error("old chat"));
    await flushPromises();
    expect(state.previewError).toBeUndefined();
    expect(state.preview).toBeUndefined();
  });

  it("keeps static previews and exposes a safe error state on failed app data reads", async () => {
    const state: ApprovalPreviewState = { preview: { summary: "Proposed sett", fields: [{ label: "Name", value: "Moss" }] } };
    loadApprovalPreview(state, async () => { throw new Error("secret database details"); }, tool, {}, null, new AbortController().signal, () => true);
    await flushPromises();
    expect(state).toEqual({ preview: { summary: "Proposed sett", fields: [{ label: "Name", value: "Moss" }] }, previewLoading: false, previewError: true });
  });

  it("does not invoke hooks after a run was already cancelled", async () => {
    const parent = new AbortController();
    parent.abort();
    const hook = vi.fn();
    loadApprovalPreview({}, hook, tool, {}, null, parent.signal, () => true);
    await flushPromises();
    expect(hook).not.toHaveBeenCalled();
  });
});
