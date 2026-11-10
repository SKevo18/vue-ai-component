import { flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { componentAi } from "../test/component-ai";
import { scriptedTransport, toolOutputs } from "../test/fake-provider";
import type { ApprovalPreview, ApprovalPreviewContext } from "./core/approval";
import type { McpClient } from "./mcp/client";

function setup() {
  const deferred = Promise.withResolvers<ApprovalPreview>();
  let context: ApprovalPreviewContext | undefined;
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "painted" }] }));
  const mcp = {
    callTool,
    connect: async () => ({ protocolVersion: "2025-11-25", serverInfo: { name: "sett", version: "1" }, capabilities: {} }),
    listTools: async () => [{ name: "paint_badger", inputSchema: { type: "object" }, _meta: { approval: "ask" } }],
  } as unknown as McpClient;
  const ai = componentAi({ mcp: { sett: mcp }, approvalPreview: (input) => { context = input; return deferred.promise; } }, { transport: () => scriptedTransport((input) => toolOutputs(input).length ? { text: "Finished." } : { calls: [{ name: "paint_badger", args: { color: "blue" } }] }) });
  return { ai, callTool, deferred, context: () => context };
}

describe("approval preview lifecycle", () => {
  it("aborts a pending preview when switching chats and ignores its late result", async () => {
    const { ai, callTool, deferred, context } = setup();
    const run = ai.send("Paint the badger");
    await vi.waitFor(() => expect(ai.state.approval?.tool).toBe("paint_badger"));
    await flushPromises();
    const old = ai.state.approval!;
    expect(old.previewLoading).toBe(true);
    await ai.newChat();
    await run;
    expect(context()?.signal.aborted).toBe(true);
    deferred.resolve({ summary: "Late preview", before: "brown", after: "blue" });
    await flushPromises();
    expect(ai.state.approval).toBeNull();
    expect(ai.state.entries).toEqual([]);
    expect(old.preview).toBeUndefined();
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(["approve", "deny"] as const)("does not wait for preview reads before %s and cancels them", async (decision) => {
    const { ai, callTool, deferred, context } = setup();
    const run = ai.send("Paint the badger");
    await vi.waitFor(() => expect(ai.state.approval).not.toBeNull());
    await flushPromises();
    ai.decide(decision);
    await run;
    expect(context()?.signal.aborted).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
    deferred.resolve({ summary: "Too late" });
    await flushPromises();
    expect(ai.state.approval).toBeNull();
  });
});
