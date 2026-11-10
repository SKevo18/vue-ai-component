import type { JsonSchema } from "../core/types";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  _meta?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  _meta?: Record<string, unknown>;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

export type McpResourceContents = { uri: string; mimeType?: string; text: string } | { uri: string; mimeType?: string; blob: string };

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; title?: string; description?: string; mimeType?: string }
  | { type: "resource"; resource: McpResourceContents };

export interface McpToolResult {
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpServerInfo {
  protocolVersion: string;
  serverInfo: { name: string; title?: string; version: string };
  capabilities: Record<string, unknown>;
  instructions?: string;
}

export type McpErrorKind = "rpc" | "http" | "network" | "aborted" | "protocol";

export class McpError extends Error {
  readonly kind: McpErrorKind;
  readonly code?: number;
  readonly status?: number;
  readonly data?: unknown;

  constructor(kind: McpErrorKind, message: string, details: { code?: number; status?: number; data?: unknown } = {}) {
    super(message);
    this.name = "McpError";
    this.kind = kind;
    this.code = details.code;
    this.status = details.status;
    this.data = details.data;
  }
}
