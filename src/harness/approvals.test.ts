import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type { ToolEntry } from "../core/entries";
import type { HarnessTool } from "../core/tools";
import { DEFAULT_PREFERENCES } from "../stores/preferences";
import { createApprovals } from "./approvals";
import type { AiState } from "./types";

function setup() {
  const state = reactive({ approval: null, allowedTools: [], chatAutoApprove: false, preferences: { ...DEFAULT_PREFERENCES }, conversationId: "c1" }) as unknown as AiState;
  const approvals = createApprovals(state, { backend: {} as never }, null);
  const tool = (name: string, approval: HarnessTool["approval"] = "ask"): HarnessTool => ({ name, description: name, parameters: {}, approval, readOnly: true, run: vi.fn() });
  const entry = (id: string): ToolEntry => ({ id, role: "tool", toolCallId: id, name: id, args: {}, content: "", status: "awaiting" });
  const signal = new AbortController().signal;
  return { state, approvals, tool, entry, signal };
}

describe("approvals", () => {
  it("queues concurrent calls instead of overwriting the pending one", async () => {
    const { state, approvals, tool, entry, signal } = setup();
    const first = approvals.confirm(tool("peek_a"), entry("a"), signal, "c1");
    const second = approvals.confirm(tool("peek_b"), entry("b"), signal, "c1");
    expect(state.approval?.tool).toBe("peek_a");
    approvals.decide("approve");
    expect(await first).toBe(true);
    expect(state.approval?.tool).toBe("peek_b");
    approvals.decide("deny");
    expect(await second).toBe(false);
    expect(state.approval).toBeNull();
  });

  it("denies every queued call when cancelled", async () => {
    const { state, approvals, tool, entry, signal } = setup();
    const calls = [approvals.confirm(tool("peek_a"), entry("a"), signal, "c1"), approvals.confirm(tool("peek_b"), entry("b"), signal, "c1")];
    approvals.cancel();
    expect(await Promise.all(calls)).toEqual([false, false]);
    expect(state.approval).toBeNull();
  });

  it("runs queued calls of a tool allowed for the chat and of calls auto-approval now covers", async () => {
    const { state, approvals, tool, entry, signal } = setup();
    const first = approvals.confirm(tool("peek_a"), entry("a"), signal, "c1");
    const second = approvals.confirm(tool("peek_a"), entry("b"), signal, "c1");
    const third = approvals.confirm(tool("dig"), entry("c"), signal, "c1");
    approvals.decide("always");
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(state.approval?.tool).toBe("dig");
    state.chatAutoApprove = true;
    approvals.recheck();
    expect(await third).toBe(true);
    expect(state.approval).toBeNull();
  });

  it("never remembers or skips confirm-tier tools", async () => {
    const { state, approvals, tool, entry, signal } = setup();
    const send = tool("send_mail", "confirm");
    const call = approvals.confirm(send, entry("a"), signal, "c1");
    approvals.decide("always");
    expect(await call).toBe(true);
    expect(state.allowedTools).toEqual([]);
    state.allowedTools.push("send_mail");
    state.chatAutoApprove = true;
    state.preferences.autoApproveWrites = true;
    expect(approvals.needsApproval(send)).toBe(true);
    state.preferences.autoApproveExternal = true;
    expect(approvals.needsApproval(send)).toBe(false);
  });
});
