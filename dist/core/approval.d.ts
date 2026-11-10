import type { McpClient } from "../mcp/client";
import type { McpResourceContents, McpToolResult } from "../mcp/types";
import type { HarnessTool } from "./tools";
export interface ApprovalPreviewField {
    label: string;
    value: string;
}
/** presentation only: it never changes arguments or grants approval; values render as plain text */
export interface ApprovalPreview {
    summary?: string;
    categoryHint?: string;
    fields?: ApprovalPreviewField[];
    before?: string;
    after?: string;
}
export interface ApprovalPreviewContext {
    tool: Pick<HarnessTool, "name" | "title" | "parameters">;
    args: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    /** reads app resources through MCP, never through app REST endpoints */
    readResource(uri: string): Promise<McpResourceContents[]>;
    /** calls only discovered MCP tools annotated readOnlyHint: true */
    readTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}
export type ApprovalPreviewHook = (context: ApprovalPreviewContext) => ApprovalPreview | null | undefined | Promise<ApprovalPreview | null | undefined>;
export declare function parseApprovalPreview(value: unknown): ApprovalPreview | undefined;
export declare function initialApprovalPreview(tool: HarnessTool, args: Record<string, unknown>): ApprovalPreview | undefined;
export interface ApprovalPreviewState {
    preview?: ApprovalPreview;
    previewLoading?: boolean;
    previewError?: boolean;
}
/** cancelling also cancels preview reads; late results never update a later approval */
export declare function loadApprovalPreview(state: ApprovalPreviewState, hook: ApprovalPreviewHook | undefined, tool: HarnessTool, args: Record<string, unknown>, client: McpClient | null, parent: AbortSignal, isCurrent: () => boolean): () => void;
