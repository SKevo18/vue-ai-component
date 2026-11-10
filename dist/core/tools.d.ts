import type { Approval, ImageRef, ResourceLink } from "./entries";
import type { ApprovalPreview } from "./approval";
import type { ImageContent, JsonSchema, ToolSpec } from "./types";
export interface ToolResult {
    text: string;
    isError?: boolean;
    images?: ImageRef[];
    links?: ResourceLink[];
}
export interface ToolContext {
    signal: AbortSignal;
    conversationId: string;
    saveImage(image: ImageContent, name?: string): Promise<ImageRef>;
    onProgress?(message: string): void;
}
export interface HarnessTool {
    name: string;
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
