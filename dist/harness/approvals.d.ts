import type { ToolEntry } from "../core/entries";
import type { HarnessTool } from "../core/tools";
import type { McpServers } from "../mcp/servers";
import type { AiOptions, AiState, Decision } from "./types";
export interface Approvals {
    needsApproval(tool: HarnessTool): boolean;
    confirm(tool: HarnessTool, entry: ToolEntry, signal: AbortSignal, conversationId: string): Promise<boolean>;
    decide(decision: Decision): void;
    recheck(): void;
    cancel(): void;
}
export declare function createApprovals(state: AiState, options: AiOptions, servers: McpServers | null): Approvals;
