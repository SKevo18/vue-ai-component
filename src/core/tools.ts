import type { Approval, ImageRef, ResourceLink } from "./entries";
import type { ApprovalPreview } from "./approval";
import { coerce, validate } from "./schema";
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
export const TOOL_RESULT_LIMIT = 40000;

export function toolSpecs(tools: HarnessTool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export function prepareCall(tools: HarnessTool[], name: string, rawArgs: Record<string, unknown>): { tool: HarnessTool; args: Record<string, unknown> } | { error: string } {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: `Unknown tool ${name}. Available tools: ${tools.map((t) => t.name).join(", ")}.` };
  if (typeof rawArgs._raw === "string") return { error: `The arguments of ${name} are not valid JSON. Send a JSON object.` };
  const args = coerce(tool.parameters, rawArgs) as Record<string, unknown>;
  const errors = validate(tool.parameters, args);
  if (errors.length) return { error: `Invalid arguments for ${name}: ${errors.join("; ")}.` };
  return { tool, args };
}

export function clipResult(text: string, hint = ""): string {
  if (text.length <= TOOL_RESULT_LIMIT) return text;
  let end = TOOL_RESULT_LIMIT;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}\n\n[Truncated: ${text.length - end} more characters.${hint ? ` ${hint}` : ""}]`;
}

export function toolDetail(args: Record<string, unknown>): string {
  const cut = (v: string) => (v.length > 60 ? v.slice(0, 60) + "..." : v);
  for (const key of ["uri", "q", "query", "name", "title", "subject", "path", "id"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return cut(v);
    if (typeof v === "number") return String(v);
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) return cut(v.replace(/\s+/g, " "));
    if (typeof v === "number") return String(v);
  }
  return "";
}
