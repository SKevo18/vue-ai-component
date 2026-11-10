import { toRaw } from "vue";
import { initialApprovalPreview, loadApprovalPreview } from "../core/approval";
import type { ToolEntry } from "../core/entries";
import type { HarnessTool } from "../core/tools";
import type { McpClient } from "../mcp/client";
import type { AiOptions, AiState, Decision, PendingApproval } from "./types";

interface Waiting {
  pending: PendingApproval;
  tool: HarnessTool;
  signal: AbortSignal;
  conversationId: string;
  resolve(ok: boolean): void;
}

export interface Approvals {
  needsApproval(tool: HarnessTool): boolean;
  confirm(tool: HarnessTool, entry: ToolEntry, signal: AbortSignal, conversationId: string): Promise<boolean>;
  decide(decision: Decision): void;
  recheck(): void;
  cancel(): void;
}

export function createApprovals(state: AiState, options: AiOptions, mcp: McpClient | null): Approvals {
  const queue: Waiting[] = [];
  let cancelPreview: (() => void) | null = null;

  function needsApproval(tool: HarnessTool): boolean {
    if (tool.approval === "auto") return false;
    if (tool.approval === "confirm") return !state.preferences.autoApproveExternal;
    return !(state.allowedTools.includes(tool.name) || state.preferences.autoApproveWrites || state.chatAutoApprove);
  }

  function show() {
    const head = queue[0];
    if (head && state.approval && toRaw(state.approval) === head.pending) return;
    cancelPreview?.();
    cancelPreview = null;
    if (!head) {
      state.approval = null;
      return;
    }
    state.approval = head.pending;
    const shown = state.approval;
    cancelPreview = loadApprovalPreview(shown, options.approvalPreview, head.tool, shown.args, mcp, head.signal, () => state.approval === shown && state.conversationId === head.conversationId);
  }

  function recheck() {
    for (const waiting of [...queue]) {
      if (needsApproval(waiting.tool)) continue;
      queue.splice(queue.indexOf(waiting), 1);
      waiting.resolve(true);
    }
    show();
  }

  return {
    needsApproval,
    confirm(tool, entry, signal, conversationId) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const pending: PendingApproval = { toolCallId: entry.toolCallId, tool: tool.name, title: tool.title, approval: tool.approval, args: entry.args, preview: initialApprovalPreview(tool, entry.args) };
      queue.push({ pending, tool, signal, conversationId, resolve });
      show();
      return promise;
    },
    decide(decision) {
      const head = queue.shift();
      if (!head) return;
      cancelPreview?.();
      cancelPreview = null;
      state.approval = null;
      if (decision === "always" && head.tool.approval !== "confirm" && !state.allowedTools.includes(head.tool.name)) state.allowedTools.push(head.tool.name);
      head.resolve(decision !== "deny");
      recheck();
    },
    recheck,
    cancel() {
      for (const waiting of queue.splice(0)) waiting.resolve(false);
      show();
    },
  };
}
