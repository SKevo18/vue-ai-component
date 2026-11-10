import type { Entry, ImageRef, ToolEntry } from "./entries";
import { type HarnessTool, type ToolContext } from "./tools";
import { type ChatFn, type Dialect, type ImageContent } from "./types";
export declare const RETRY_DELAYS: number[];
export declare const REJECTED = "The user rejected this action. Do not retry it unless asked.";
/** the state began at `since` (ms epoch) */
export interface Activity {
    kind: "thinking" | "writing" | "tool" | "approval" | "retry" | null;
    tool?: string;
    detail?: string;
    since: number;
}
export interface AgentRun {
    chat: ChatFn;
    model: string;
    dialect: Dialect;
    system: string;
    cacheKey?: string;
    tools: HarnessTool[];
    entries: Entry[];
    needsApproval(tool: HarnessTool, args: Record<string, unknown>): boolean;
    confirm(tool: HarnessTool, entry: ToolEntry): Promise<boolean>;
    loadImage(ref: ImageRef): Promise<ImageContent>;
    context: Omit<ToolContext, "signal">;
    onActivity?(activity: Activity): void;
    signal: AbortSignal;
    newId(): string;
}
export declare function repairEntries(entries: Entry[], newId: () => string): Entry[];
export declare function runAgent(run: AgentRun): Promise<void>;
