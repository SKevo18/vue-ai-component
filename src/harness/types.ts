import type { MaybeRefOrGetter } from "vue";
import type { AiBackend, AiConnection, AiModel } from "../backend/types";
import type { BrowserToolHost } from "../browser/tool-host";
import type { Activity } from "../core/agent";
import type { ApprovalPreviewHook, ApprovalPreviewState } from "../core/approval";
import type { PdfOptions } from "../core/attachments";
import type { Approval, Entry, ImageRef, ResourceRef } from "../core/entries";
import type { LocalNamespace, NamespaceRegistry, ReadOptions, ReadResult } from "../core/namespaces";
import type { PlanStep } from "../core/plan";
import type { PromptSkill } from "../core/prompt";
import type { HarnessTool } from "../core/tools";
import type { AiErrorKind } from "../core/types";
import type { Locale, MessageOverrides, Translate } from "../i18n";
import type { McpClient } from "../mcp/client";
import type { McpServerConfig, McpServerState } from "../mcp/servers";
import type { ConversationMeta, ConversationStore } from "../stores/conversations";
import type { AiPreferences, PreferencesStore } from "../stores/preferences";

export type ContextItem = ResourceRef;

export interface Suggestion {
  label: string;
  prompt: string;
  resources?: ResourceRef[];
}

export interface AiOptions {
  backend: AiBackend;
  /** keyed by server id; tools two servers share are offered as `<id>__<tool>` */
  mcp?: Readonly<Record<string, McpServerConfig>>;
  toolHost?: BrowserToolHost;
  name?: string;
  /** keep it stable between runs so prompt caching works */
  instructions?: MaybeRefOrGetter<string | undefined>;
  context?: MaybeRefOrGetter<ContextItem[]>;
  searchResources?(query: string, signal: AbortSignal): Promise<ResourceRef[]>;
  openResource?(uri: string): void;
  openSettings?(): void;
  namespaces?: LocalNamespace[];
  skills?: PromptSkill[];
  suggestions?: MaybeRefOrGetter<Suggestion[]>;
  conversations?: ConversationStore;
  preferences?: PreferencesStore;
  /** prefix of localStorage keys and the IndexedDB name, default `ai:` */
  storagePrefix?: string;
  locale?: MaybeRefOrGetter<Locale | string | undefined>;
  messages?: Partial<Record<Locale, MessageOverrides>>;
  pdf?: PdfOptions;
  /**
   * replaces the built-in renderer; its output is still sanitised and remote images are dropped. Resource URIs are
   * not linked for you: emit `<a data-ai-resource="uri">` to make them open resources.
   */
  markdown?: (source: string) => string;
  approvalPreview?: ApprovalPreviewHook;
}

export interface AttachedFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

export interface ResourcePreview {
  uri: string;
  original?: AttachedFile;
}

export interface PendingApproval extends ApprovalPreviewState {
  toolCallId: string;
  tool: string;
  title?: string;
  approval: Approval;
  args: Record<string, unknown>;
}

/** for confirm-tier tools, which ask every time, "always" counts as "approve" */
export type Decision = "approve" | "always" | "deny";

export interface ModelList {
  items: AiModel[];
  loading: boolean;
  error: string;
}

export interface ChatError {
  kind: AiErrorKind | "tools";
  message: string;
}

export interface ComposeOptions {
  resources?: ResourceRef[];
  send?: boolean;
}

export interface PickerItem extends ResourceRef {
  group: "context" | "resources" | "skills" | "results";
  description?: string;
}

export interface AiState {
  connections: AiConnection[];
  connectionsLoaded: boolean;
  connectionsError: string;
  models: Record<string, ModelList>;
  preferences: AiPreferences;
  conversationId: string;
  title: string;
  entries: Entry[];
  attached: ResourceRef[];
  dismissed: string[];
  allowedTools: string[];
  chatAutoApprove: boolean;
  running: boolean;
  activity: Activity;
  runStartedAt: number;
  error: ChatError | null;
  approval: PendingApproval | null;
  history: ConversationMeta[];
  draft: string;
  mcp: Record<string, McpServerState>;
  storageError: string;
  adding: string[];
  attachError: string;
  toolTitles: Record<string, string>;
  focusRequest: number;
  preview: ResourcePreview | null;
}

export interface Ai {
  readonly state: AiState;
  readonly t: Translate;
  readonly locale: () => Locale;
  readonly options: AiOptions;
  readonly mcp: Readonly<Record<string, McpClient>>;
  readonly namespaces: NamespaceRegistry;
  readonly toolHost: BrowserToolHost | null;
  readonly connection: AiConnection | null;
  readonly model: string;
  readonly ready: boolean;
  readonly plan: PlanStep[] | null;
  readonly chips: ResourceRef[];
  readonly suggestions: Suggestion[];
  init(): Promise<void>;
  refreshConnections(): Promise<void>;
  loadModels(id: string, refresh?: boolean): Promise<void>;
  select(id: string, model?: string): Promise<void>;
  setPreferences(patch: Partial<AiPreferences>): Promise<void>;
  send(text?: string): Promise<void>;
  compose(text: string, options?: ComposeOptions): Promise<void>;
  retry(): Promise<void>;
  stop(): void;
  decide(decision: Decision): void;
  setChatAutoApprove(on: boolean): void;
  resetAllowedTools(): void;
  newChat(): Promise<void>;
  openChat(id: string): Promise<void>;
  removeChat(id: string): Promise<void>;
  renameChat(id: string, title: string): Promise<void>;
  loadHistory(): Promise<void>;
  flush(): Promise<void>;
  searchHistory(query: string, cache?: Map<string, string>): Promise<ConversationMeta[]>;
  attachFiles(files: Iterable<File>): Promise<void>;
  attachText(text: string, name: string): Promise<ResourceRef | null>;
  attach(ref: ResourceRef): void;
  detach(uri: string): void;
  tools(refresh?: boolean): Promise<HarnessTool[]>;
  pickerItems(query: string, signal: AbortSignal): Promise<PickerItem[]>;
  read(uri: string, options?: ReadOptions): Promise<ReadResult>;
  imageUrl(ref: ImageRef): Promise<string>;
  openResource(uri: string): void;
  previewResource(uri: string): void;
  closePreview(): void;
  complete(system: string, user: string, options?: { signal?: AbortSignal; onDelta?: (text: string) => void }): Promise<string>;
  completeResult(system: string, user: string, options?: { signal?: AbortSignal; onDelta?: (text: string) => void }): Promise<{ text: string; truncated: boolean }>;
  files(): Promise<AttachedFile[]>;
  removeAllChats(): Promise<void>;
  /** debugging JSON with entries, the system prompt and tool definitions; attachment bytes, keys and tokens stay out */
  exportConversation(id?: string): Promise<{ filename: string; json: string }>;
}
