import type { Approval, ImageRef, ResourceLink } from "./entries";
import type { ApprovalPreview } from "./approval";
import type { ImageContent, JsonSchema, ToolSpec } from "./types";
export interface ToolResult {
    text: string;
    isError?: boolean;
    images?: ImageRef[];
    links?: ResourceLink[];
}
/** a file the user attached to the chat, with its original bytes */
export interface AttachedFile {
    uri: string;
    name: string;
    mimeType: string;
    size: number;
    blob: Blob;
}
export interface ToolContext {
    signal: AbortSignal;
    conversationId: string;
    saveImage(image: ImageContent, name?: string): Promise<ImageRef>;
    /** the files attached to this chat (sent messages and the composer), with their bytes */
    files(): Promise<AttachedFile[]>;
    onProgress?(message: string): void;
}
export interface HarnessTool {
    name: string;
    /** set for MCP tools; `name` gains a `<server>__` prefix when two servers offer the same tool */
    mcp?: {
        server: string;
        tool: string;
    };
    title?: string;
    description: string;
    parameters: JsonSchema;
    approval: Approval;
    approvalPreview?: ApprovalPreview;
    /** read-only `auto` calls in a row run in parallel */
    readOnly: boolean;
    keep?(args: Record<string, unknown>): boolean;
    run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
/** characters of tool output passed to the model per result; the rest is cut with a note */
export declare const TOOL_RESULT_LIMIT = 40000;
export declare function toolSpecs(tools: HarnessTool[]): ToolSpec[];
export declare function prepareCall(tools: HarnessTool[], name: string, rawArgs: Record<string, unknown>): {
    tool: HarnessTool;
    args: Record<string, unknown>;
} | {
    error: string;
};
export declare function clipResult(text: string, hint?: string): string;
export declare function toolDetail(args: Record<string, unknown>): string;
