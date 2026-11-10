import type { Approval } from "../core/entries";
import { type HarnessTool, type ToolContext, type ToolResult } from "../core/tools";
import type { McpClient } from "./client";
import type { McpTool, McpToolResult } from "./types";
/**
 * from `_meta.approval` when the server sets it, else from the annotations: read-only runs without asking unless it
 * reaches the outside world, open-world or destructive asks for confirmation, anything else asks.
 */
export declare function toolApproval(tool: McpTool): Approval;
export declare function toolResult(result: McpToolResult, ctx: Pick<ToolContext, "saveImage">): Promise<ToolResult>;
export declare function mcpHarnessTool(tool: McpTool, client: McpClient, server: string, name?: string): HarnessTool;
