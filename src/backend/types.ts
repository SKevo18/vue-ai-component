import type { Dialect } from "../core/types";

export type ConnectionKind = "key" | "subscription" | "site";

export interface AiConnection {
  id: string;
  kind: ConnectionKind;
  dialect: Dialect;
  name: string;
  connected: boolean;
  account?: string;
  /** false prevents selection; connected settings cards stay visible so credentials can be removed */
  enabled: boolean;
  login?: "device" | "paste";
  keysUrl?: string;
  usageUrl?: string;
  note?: string;
  description?: string;
  warning?: string;
  wire?: { toolNamespace?: string; reasoning?: boolean };
}

export interface AiModel {
  id: string;
  name?: string;
}

export type LoginStart =
  /** device code flow: the user opens `url` and enters `code`; the UI polls completeLogin every `interval` seconds */
  | { kind: "device"; url: string; code: string; interval: number; expiresIn?: number }
  | { kind: "paste"; url: string; hint?: string; expiresIn?: number };

export type LoginResult = "pending" | "connected";

export interface ChatTransportRequest {
  dialect: Dialect;
  model: string;
  body: Record<string, unknown>;
}

export type ChatTransport = (request: ChatTransportRequest, signal?: AbortSignal) => Promise<Response>;

export interface AiBackend {
  connections(): Promise<AiConnection[]>;
  startLogin?(id: string): Promise<LoginStart>;
  completeLogin?(id: string, pasted?: string): Promise<LoginResult>;
  logout?(id: string): Promise<void>;
  saveKey?(id: string, key: string | null): Promise<void>;
  /** removes only browser-stored API keys, never server keys or subscription credentials */
  clearBrowserKeys?(): Promise<void>;
  models(id: string, signal?: AbortSignal): Promise<AiModel[]>;
  transport(id: string): ChatTransport;
}
