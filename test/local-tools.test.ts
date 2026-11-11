// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { toRaw, watch } from "vue";
import type { HarnessTool } from "../src/core/tools";
import { componentAi } from "./component-ai";
import { scriptedTransport, toolOutputs, type ResponsesInputItem } from "./fake-provider";

/** Calls `tool` once with `args` for every user message, then answers with the tool's output. */
function callOnce(tool: string, args: Record<string, unknown>) {
  return scriptedTransport((input: ResponsesInputItem[]) => {
    const sinceUser = input.length - 1 - [...input].reverse().findIndex((i) => i.role === "user");
    const fresh = toolOutputs(input.slice(sinceUser));
    if (!fresh.length) return { calls: [{ name: tool, args }] };
    return { text: `answer: ${fresh.at(-1)}` };
  });
}

function countTool(approval: HarnessTool["approval"]) {
  const run = vi.fn<HarnessTool["run"]>(async (_, ctx) => ({ text: (await ctx.files()).map((f) => `${f.name}=${f.size}`).join(",") || "none" }));
  return { name: "count_files", title: "Count the attached files", description: "Lists attached files.", parameters: { type: "object", properties: {} }, approval, readOnly: true, run } satisfies HarnessTool;
}

describe("local tools", () => {
  it("offers them next to the built-ins and hands them the chat's attachments", async () => {
    const tool = countTool("auto");
    const ai = componentAi({ tools: [tool], storagePrefix: "local-auto:" }, { transport: () => callOnce("count_files", {}) });
    await ai.init();
    expect((await ai.tools()).map((t) => t.name)).toEqual(["count_files", "read", "update_plan"]);
    expect(ai.state.toolTitles).toEqual({ count_files: "Count the attached files" });
    await ai.attachText("frob,quux\n1,2\n", "zorp.csv");
    await ai.send("count");
    expect(ai.state.entries.at(-1)).toMatchObject({ role: "assistant", content: "answer: zorp.csv=14" });
    const [, ctx] = tool.run.mock.calls[0]!;
    expect(ctx.conversationId).toBe(ai.state.conversationId);
  });

  it("asks before an ask-tier local tool runs and reports a denial", async () => {
    const tool = countTool("ask");
    const ai = componentAi({ tools: [tool], storagePrefix: "local-ask:" }, { transport: () => callOnce("count_files", {}) });
    await ai.init();
    const run = ai.send("count");
    await vi.waitFor(() => expect(ai.state.approval).not.toBeNull());
    expect(ai.state.approval).toMatchObject({ tool: "count_files", approval: "ask" });
    ai.decide("deny");
    await run;
    expect(tool.run).not.toHaveBeenCalled();
    expect(ai.state.entries.find((e) => e.role === "tool")).toMatchObject({ status: "rejected", isError: true });
  });

  it("keeps the chat running without an unreachable MCP server and lets the user close its notice", async () => {
    const ai = componentAi({ tools: [countTool("auto")], mcp: { plugh: { url: "http://127.0.0.1:9/mcp", name: "Plugh docs" } }, storagePrefix: "local-mcp:" }, { transport: () => callOnce("count_files", {}) });
    await ai.init();
    expect(ai.state.mcp.plugh).toMatchObject({ name: "Plugh docs", error: "" });
    const errors: unknown[] = [];
    const watching = watch(() => ai.state.error, (error) => error && errors.push(structuredClone(toRaw(error))), { flush: "sync" });
    await ai.send("count");
    watching();
    expect(ai.state.entries.at(-1)).toMatchObject({ role: "assistant", content: "answer: none" });
    expect(ai.state.mcp.plugh!.error).toContain("Cannot reach the MCP server");
    expect(errors).toEqual([{ kind: "tools", message: "Tools from Plugh docs are unavailable.", failures: [{ id: "plugh", name: "Plugh docs", error: ai.state.mcp.plugh!.error }] }]);
    expect(ai.state.error).toBeNull();
    ai.dismissError("tools");
    expect(ai.state.dismissedTools).not.toBe("");

    const seen: (string | undefined)[] = [];
    const stop = watch(() => ai.state.error?.kind, (kind) => seen.push(kind), { flush: "sync" });
    await ai.send("again");
    stop();
    expect(seen).not.toContain("tools");
  });

  it("closes the chat's error and the storage notice", async () => {
    const ai = componentAi({ storagePrefix: "local-dismiss:" });
    ai.state.mcp.zorp = { name: "Zorp", info: null, error: "zorp" };
    ai.state.error = { kind: "tools", message: "Tools from Zorp are unavailable.", failures: [{ id: "zorp", name: "Zorp", error: "zorp" }] };
    ai.state.storageError = "disk full";
    ai.dismissError();
    expect(ai.state.error).toBeNull();
    expect(ai.state.dismissedTools).not.toBe("");
    expect(ai.state.storageError).toBe("disk full");
    ai.dismissError("storage");
    expect(ai.state.storageError).toBe("");
  });
});
