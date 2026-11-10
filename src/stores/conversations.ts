import type { Entry, ResourceRef } from "../core/entries";

export interface ConversationMeta {
  id: string;
  title: string;
  /** ms epoch */
  updatedAt: number;
}

export interface StoredConversation extends ConversationMeta {
  entries: Entry[];
  connection?: string;
  model?: string;
  attached?: ResourceRef[];
  draft?: string;
  allowedTools?: string[];
  autoApprove?: boolean;
}

export interface ConversationStore {
  list(): Promise<ConversationMeta[]>;
  load(id: string): Promise<StoredConversation | null>;
  save(conversation: StoredConversation): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface LocalConversationStoreOptions {
  prefix?: string;
  /** conversations kept; older ones are dropped, default 50 */
  max?: number;
  storage?: Storage;
}

/** the index lives under `<prefix>conversations`, the bodies under `<prefix>conversation:<id>` */
export function createLocalConversationStore(options: LocalConversationStoreOptions = {}): ConversationStore {
  const prefix = options.prefix ?? "ai:";
  const max = options.max ?? 50;
  const storage = () => options.storage ?? globalThis.localStorage;
  const indexKey = `${prefix}conversations`;
  const bodyKey = (id: string) => `${prefix}conversation:${id}`;

  function get<T>(key: string): T | null {
    try {
      const raw = storage()?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  function set(key: string, value: unknown) {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
  }

  function index(): ConversationMeta[] {
    const list = get<ConversationMeta[]>(indexKey);
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === "string") : [];
  }

  return {
    list: async () => index(),
    load: async (id) => get<StoredConversation>(bodyKey(id)),
    async save(conversation) {
      const meta: ConversationMeta = { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt };
      set(bodyKey(conversation.id), conversation);
      const list = [meta, ...index().filter((m) => m.id !== meta.id)].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const dropped of list.splice(max)) set(bodyKey(dropped.id), null);
      set(indexKey, list);
    },
    async remove(id) {
      set(bodyKey(id), null);
      set(indexKey, index().filter((m) => m.id !== id));
    },
  };
}
