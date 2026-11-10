import { computed, inject, reactive, toValue, watch, type App, type InjectionKey } from "vue";
import { createAttachmentStore } from "./core/attachment-store";
import { configurePdf, fromBase64, normaliseImage, PASTE_ATTACHMENT_THRESHOLD } from "./core/attachments";
import { repairEntries, runAgent } from "./core/agent";
import type { Entry, ResourceRef } from "./core/entries";
import { randomId } from "./core/ids";
import { createNamespaceRegistry, schemeOf, type ReadOptions } from "./core/namespaces";
import { currentPlan } from "./core/plan";
import { AiError, errorText } from "./core/types";
import { createApprovals } from "./harness/approvals";
import { createChatAttachments } from "./harness/attachments";
import { createCatalog } from "./harness/catalog";
import { createConnections, type Target } from "./harness/connections";
import { conversationExport } from "./harness/export";
import { createPersistence } from "./harness/persistence";
import type { Ai, AiOptions, AiState, ChatError, ComposeOptions, Decision } from "./harness/types";
import { createTranslator } from "./i18n";
import { createMcpServers, serverErrors } from "./mcp/servers";
import { connectionChat } from "./providers";
import { createLocalConversationStore, type StoredConversation } from "./stores/conversations";
import { createLocalPreferencesStore, DEFAULT_PREFERENCES, type AiPreferences } from "./stores/preferences";

export type * from "./harness/types";

export const AI_KEY: InjectionKey<Ai> = Symbol("vue-ai-component");

export function useAi(): Ai {
  const ai = inject(AI_KEY, null);
  if (!ai) throw new Error("useAi() needs app.use(createAi(...)) or an `ai` prop.");
  return ai;
}

const TITLE_CHARS = 60;

function titleOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 3)}...` : flat;
}

export function createAi(options: AiOptions): Ai & { install(app: App): void } {
  const prefix = options.storagePrefix ?? "ai:";
  const conversations = options.conversations ?? createLocalConversationStore({ prefix });
  const preferencesStore = options.preferences ?? createLocalPreferencesStore({ prefix });
  const attachmentStore = createAttachmentStore(`${prefix}attachments`);
  const { t, locale } = createTranslator(() => toValue(options.locale), options.messages);
  configurePdf(options.pdf ?? null);

  const toolHost = options.toolHost ?? null;
  const servers = createMcpServers(options.mcp, toolHost ? () => toolHost.headers() : undefined);
  const hasServers = Object.keys(servers.clients).length > 0;

  const state = reactive<AiState>({
    connections: [],
    connectionsLoaded: false,
    connectionsError: "",
    models: {},
    preferences: { ...DEFAULT_PREFERENCES },
    conversationId: randomId(),
    title: "",
    entries: [],
    attached: [],
    dismissed: [],
    allowedTools: [],
    chatAutoApprove: false,
    running: false,
    activity: { kind: null, since: 0 },
    runStartedAt: 0,
    error: null,
    approval: null,
    history: [],
    draft: "",
    mcp: Object.fromEntries(Object.keys(servers.clients).map((id) => [id, { info: null, error: "" }])),
    storageError: "",
    adding: [],
    attachError: "",
    toolTitles: {},
    focusRequest: 0,
    preview: null,
  }) as AiState;

  const contextItems = computed(() => toValue(options.context) ?? []);
  watch(contextItems, (items) => {
    const open = new Set(items.map((i) => i.uri));
    const kept = state.dismissed.filter((uri) => open.has(uri));
    if (kept.length !== state.dismissed.length) state.dismissed = kept;
  });

  const persistence = createPersistence(state, conversations, preferencesStore, snapshot);
  const { setPreferences, saveNow, scheduleSave, loadHistory } = persistence;
  const connections = createConnections(state, options.backend, { t, init, setPreferences });
  const { connection, model } = connections;
  const namespaces = createNamespaceRegistry({ mcp: hasServers ? servers : null, prepareImage: (image) => normaliseImage(fromBase64(image.data, image.mimeType), image.mimeType) });
  const attachments = createChatAttachments(state, attachmentStore, { t, namespaces, attach, saveNow });
  namespaces.register(attachments.namespace);
  for (const ns of options.namespaces ?? []) namespaces.register(ns);
  const catalog = createCatalog(state, options, { servers, namespaces, locale, contextItems });
  const approvals = createApprovals(state, options, hasServers ? servers : null);

  let initPromise: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let runDone: Promise<void> = Promise.resolve();
  let sending = false;

  function snapshot(): StoredConversation {
    return {
      id: state.conversationId,
      title: state.title,
      updatedAt: Date.now(),
      entries: JSON.parse(JSON.stringify(state.entries)) as Entry[],
      connection: connection.value?.id,
      model: model.value || undefined,
      attached: state.attached.map((r) => ({ ...r })),
      draft: state.draft,
      allowedTools: [...state.allowedTools],
      autoApprove: state.chatAutoApprove,
    };
  }

  function apply(c: StoredConversation | null) {
    attachments.closePreview();
    state.conversationId = c?.id ?? randomId();
    state.title = c?.title ?? "";
    state.entries = c ? repairEntries(c.entries ?? [], () => randomId()) : [];
    state.attached = c?.attached ?? [];
    state.allowedTools = c?.allowedTools ?? [];
    state.chatAutoApprove = c?.autoApprove ?? false;
    state.dismissed = [];
    state.error = null;
    state.approval = null;
    state.activity = { kind: null, since: 0 };
    state.draft = c?.draft ?? "";
  }

  function init() {
    initPromise ??= (async () => {
      const loaded: Partial<AiPreferences> = await preferencesStore.load().catch(() => ({}));
      state.preferences = { ...DEFAULT_PREFERENCES, ...loaded, models: { ...loaded.models } };
      const last = state.preferences.conversation;
      await Promise.all([
        connections.refreshConnections(),
        loadHistory(),
        last ? conversations.load(last).then((c) => !state.entries.length && apply(c), () => undefined) : undefined,
      ]);
      if (hasServers) void catalog.tools();
    })();
    return initPromise;
  }

  async function execute() {
    if (state.running) return;
    state.running = true;
    let target: Target;
    try {
      target = await connections.target();
    } catch (e) {
      state.running = false;
      state.error = { kind: e instanceof AiError ? e.kind : "unknown", message: errorText(e) };
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    state.error = null;
    state.runStartedAt = Date.now();
    state.activity = { kind: "thinking", since: Date.now() };
    const conversationId = state.conversationId;
    const work = async () => {
      const list = await catalog.tools();
      const mcpError = serverErrors(state.mcp);
      if (mcpError) state.error = { kind: "tools", message: t("errors.tools", { message: mcpError }) };
      await runAgent({
        chat: connectionChat(target.connection, options.backend.transport(target.connection.id)),
        model: target.model,
        dialect: target.connection.dialect,
        system: await catalog.systemPrompt(),
        cacheKey: conversationId,
        tools: list,
        entries: state.entries,
        needsApproval: approvals.needsApproval,
        confirm: (tool, entry) => approvals.confirm(tool, entry, signal, conversationId),
        loadImage: (ref) => namespaces.image(ref),
        context: { conversationId, saveImage: attachments.saveImage },
        onActivity(activity) {
          state.activity = activity;
          if (activity.kind === "tool" || activity.kind === "thinking") scheduleSave();
        },
        signal,
        newId: () => randomId(),
      });
    };
    try {
      // a held lock keeps a background tab from being frozen during a run
      if (navigator.locks) await navigator.locks.request(`${prefix}run:${conversationId}`, work);
      else await work();
      if ((state.error as ChatError | null)?.kind === "tools") state.error = null;
    } catch (e) {
      if (!(e instanceof AiError && e.kind === "aborted") && !signal.aborted) {
        state.error = { kind: e instanceof AiError ? e.kind : "unknown", message: errorText(e) };
      }
    } finally {
      // chat switches wait for the run to end (halt), so this is still the run's conversation
      state.entries = repairEntries(state.entries, () => randomId());
      state.running = false;
      approvals.cancel();
      state.activity = { kind: null, since: Date.now() };
      controller = null;
      if (state.conversationId === conversationId) await saveNow();
    }
  }

  function run(): Promise<void> {
    if (!state.running) runDone = execute();
    return runDone;
  }

  function stop() {
    approvals.cancel();
    controller?.abort();
  }

  async function halt() {
    stop();
    await runDone;
  }

  async function send(text = state.draft) {
    const content = text.trim();
    if (!content || state.running || sending) return;
    sending = true;
    try {
      await init();
      let message = content;
      if (content.length > PASTE_ATTACHMENT_THRESHOLD) {
        const ref = await attachments.attachText(content, "message.txt");
        if (ref) message = ref.uri;
      }
      const resources = chips.value;
      state.entries.push({ id: randomId(), role: "user", content: message, ...(resources.length ? { resources: resources.map((r) => ({ ...r })) } : {}) });
      if (!state.title) state.title = titleOf(content);
      state.attached = [];
      if (text === state.draft) state.draft = "";
      if (state.preferences.conversation !== state.conversationId) void setPreferences({ conversation: state.conversationId });
    } finally {
      sending = false;
    }
    await run();
  }

  async function compose(text: string, opts: ComposeOptions = {}) {
    for (const r of opts.resources ?? []) attach(r);
    const draft = state.draft;
    state.draft = !draft.trim() ? text : /\s$/.test(draft) ? draft + text : `${draft} ${text}`;
    if (opts.send) await send();
    else state.focusRequest++;
  }

  function attach(ref: ResourceRef) {
    state.dismissed = state.dismissed.filter((u) => u !== ref.uri);
    if (!state.attached.some((r) => r.uri === ref.uri)) state.attached.push({ ...ref });
    scheduleSave();
  }

  function detach(uri: string) {
    const before = state.attached.length;
    state.attached = state.attached.filter((r) => r.uri !== uri);
    if (before === state.attached.length && contextItems.value.some((c) => c.uri === uri) && !state.dismissed.includes(uri)) state.dismissed.push(uri);
    scheduleSave();
  }

  async function removeAttachments(remove: () => Promise<void>) {
    try {
      await remove();
    } catch (e) {
      state.storageError = errorText(e);
    }
  }

  async function startOver() {
    catalog.forgetTools();
    apply(null);
    await setPreferences({ conversation: null });
  }

  async function completeResult(system: string, user: string, opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {}) {
    const target = await connections.target();
    const chat = connectionChat(target.connection, options.backend.transport(target.connection.id));
    const res = await chat({ model: target.model, system, messages: [{ role: "user", content: user }], tools: [] }, opts.onDelta ? (text, kind) => kind === "text" && opts.onDelta!(text) : undefined, opts.signal);
    return { text: res.text.trim(), truncated: res.truncated === true };
  }

  const chips = computed(() => {
    const out = contextItems.value.filter((c) => !state.dismissed.includes(c.uri));
    for (const r of state.attached) if (!out.some((c) => c.uri === r.uri)) out.push(r);
    return out;
  });
  const plan = computed(() => currentPlan(state.entries));
  const suggestions = computed(() => toValue(options.suggestions) ?? []);

  const ai = {
    state,
    t,
    locale,
    options,
    mcp: servers.clients,
    namespaces,
    toolHost,
    get connection() {
      return connection.value;
    },
    get model() {
      return model.value;
    },
    get ready() {
      return connection.value !== null;
    },
    get plan() {
      return plan.value;
    },
    get chips() {
      return chips.value;
    },
    get suggestions() {
      return suggestions.value;
    },
    init,
    refreshConnections: connections.refreshConnections,
    loadModels: connections.loadModels,
    select: connections.select,
    setPreferences,
    send,
    compose,
    async retry() {
      if (state.running || !state.entries.length) return;
      await run();
    },
    stop,
    decide: (decision: Decision) => approvals.decide(decision),
    setChatAutoApprove(on: boolean) {
      state.chatAutoApprove = on;
      approvals.recheck();
      scheduleSave();
    },
    resetAllowedTools() {
      state.allowedTools = [];
      scheduleSave();
    },
    async newChat() {
      await halt();
      await saveNow();
      await startOver();
    },
    async openChat(id: string) {
      if (id === state.conversationId) return;
      await halt();
      await saveNow();
      const c = await conversations.load(id);
      if (!c) {
        await loadHistory();
        return;
      }
      apply(c);
      await setPreferences({ conversation: id });
    },
    async removeChat(id: string) {
      const current = id === state.conversationId;
      if (current) {
        await halt();
        await persistence.settle();
      }
      await conversations.remove(id);
      await removeAttachments(() => attachmentStore.removeConversation(id));
      if (current) await startOver();
      await loadHistory();
    },
    async renameChat(id: string, title: string) {
      const clean = titleOf(title) || t("historyView.untitled");
      if (id === state.conversationId) {
        state.title = clean;
        await saveNow();
        return;
      }
      const c = await conversations.load(id);
      if (!c) return;
      await conversations.save({ ...c, title: clean });
      await loadHistory();
    },
    loadHistory,
    flush: saveNow,
    searchHistory: persistence.searchHistory,
    attachFiles: attachments.attachFiles,
    attachText: attachments.attachText,
    attach,
    detach,
    tools: (refresh?: boolean) => catalog.tools(refresh),
    pickerItems: catalog.pickerItems,
    read: (uri: string, opts?: ReadOptions) => namespaces.read(uri, opts),
    imageUrl: attachments.imageUrl,
    previewResource: attachments.previewResource,
    closePreview: attachments.closePreview,
    openResource(uri: string) {
      if (schemeOf(uri) === "attachment") attachments.previewResource(uri);
      else options.openResource?.(uri);
    },
    complete: async (system: string, user: string, opts?: { signal?: AbortSignal; onDelta?: (text: string) => void }) => (await completeResult(system, user, opts)).text,
    completeResult,
    files: attachments.files,
    async removeAllChats() {
      await halt();
      await persistence.settle();
      for (const meta of await conversations.list()) await conversations.remove(meta.id);
      await removeAttachments(() => attachmentStore.clear());
      await startOver();
      await loadHistory();
    },
    async exportConversation(id = state.conversationId) {
      const current = id === state.conversationId;
      const stored = current ? snapshot() : await conversations.load(id);
      if (!stored) throw new Error(`Conversation ${id} was not found.`);
      return conversationExport({ state, stored, current, catalog, connection: connection.value?.id ?? null, model: model.value || null, context: contextItems.value });
    },
    install(app: App) {
      app.provide(AI_KEY, ai);
    },
  };
  return ai;
}
