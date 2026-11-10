import type { McpServers } from "../mcp/servers";
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
  /** the server's own tool name, without a collision prefix */
  tool: Pick<HarnessTool, "name" | "title" | "parameters">;
  /** id of the MCP server the tool comes from */
  server?: string;
  args: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  /** reads app resources through MCP, never through app REST endpoints */
  readResource(uri: string): Promise<McpResourceContents[]>;
  /** calls only read-only tools of the same MCP server */
  readTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export type ApprovalPreviewHook = (context: ApprovalPreviewContext) => ApprovalPreview | null | undefined | Promise<ApprovalPreview | null | undefined>;

export function parseApprovalPreview(value: unknown): ApprovalPreview | undefined {
  if (!value || typeof value !== "object") return;
  const source = value as Record<string, unknown>;
  const preview: ApprovalPreview = {};
  for (const key of ["summary", "categoryHint", "before", "after"] as const) {
    if (typeof source[key] === "string") preview[key] = source[key];
  }
  if (Array.isArray(source.fields)) {
    preview.fields = source.fields.flatMap((field) => field && typeof field === "object" && typeof field.label === "string" && typeof field.value === "string" ? [{ label: field.label, value: field.value }] : []);
  }
  return Object.keys(preview).length ? preview : undefined;
}

export function initialApprovalPreview(tool: HarnessTool, args: Record<string, unknown>): ApprovalPreview | undefined {
  const fields = Object.entries(args).flatMap(([key, value]) => {
    const title = tool.parameters.properties?.[key]?.title;
    return typeof title === "string" ? [{ label: title, value: typeof value === "string" ? value : JSON.stringify(value) ?? String(value) }] : [];
  });
  if (!fields.length) return tool.approvalPreview;
  return { fields, ...tool.approvalPreview };
}

export interface ApprovalPreviewState {
  preview?: ApprovalPreview;
  previewLoading?: boolean;
  previewError?: boolean;
}

/** cancelling also cancels preview reads; late results never update a later approval */
export function loadApprovalPreview(state: ApprovalPreviewState, hook: ApprovalPreviewHook | undefined, tool: HarnessTool, args: Record<string, unknown>, servers: McpServers | null, parent: AbortSignal, isCurrent: () => boolean): () => void {
  if (!hook) return () => {};
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => { controller.abort(); parent.removeEventListener("abort", cancel); };
  if (parent.aborted) cancel();
  else parent.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) return cancel;
  state.previewLoading = true;
  const current = () => !signal.aborted && isCurrent();
  void Promise.resolve().then(() => {
    signal.throwIfAborted();
    return hook({
      tool: { name: tool.mcp?.tool ?? tool.name, title: tool.title, parameters: tool.parameters },
      server: tool.mcp?.server,
      args,
      signal,
      async readTool(name, input) {
        signal.throwIfAborted();
        const client = tool.mcp && servers?.clients[tool.mcp.server];
        if (!client) throw new Error("Approval preview needs the tool's MCP server.");
        const tools = await client.listTools({ signal });
        signal.throwIfAborted();
        if (!tools.some((entry) => entry.name === name && entry.annotations?.readOnlyHint === true)) throw new Error(`Approval preview cannot call non-read-only tool ${name}.`);
        const result = await client.callTool(name, input, { signal });
        signal.throwIfAborted();
        if (result.isError) throw new Error("Approval preview read failed.");
        return result;
      },
      async readResource(uri) {
        signal.throwIfAborted();
        if (!servers) throw new Error("Approval preview needs an MCP client.");
        const result = await servers.readResource(uri, { signal });
        signal.throwIfAborted();
        return result;
      },
    });
  }).then((preview) => {
    if (current()) {
      const parsed = parseApprovalPreview(preview);
      if (parsed) state.preview = { ...state.preview, ...parsed };
    }
  }).catch(() => {
    if (current()) state.previewError = true;
  }).finally(() => {
    if (current()) state.previewLoading = false;
    parent.removeEventListener("abort", cancel);
  });
  return cancel;
}
