import { watch } from "vue";
import type { Entry } from "../core/entries";
import { errorText } from "../core/types";
import type { ConversationMeta, ConversationStore, StoredConversation } from "../stores/conversations";
import type { AiPreferences, PreferencesStore } from "../stores/preferences";
import type { AiState } from "./types";

const SAVE_DELAY_MS = 800;

export interface Persistence {
  setPreferences(patch: Partial<AiPreferences>): Promise<void>;
  saveNow(): Promise<void>;
  scheduleSave(): void;
  settle(): Promise<void>;
  loadHistory(): Promise<void>;
  searchHistory(query: string, cache?: Map<string, string>): Promise<ConversationMeta[]>;
}

function bodyText(entries: Entry[]): string {
  return entries
    .flatMap((e) => (e.role === "user" || e.role === "assistant" ? [e.content] : []))
    .join("\n")
    .toLowerCase();
}

export function createPersistence(state: AiState, conversations: ConversationStore, preferences: PreferencesStore, snapshot: () => StoredConversation): Persistence {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveInFlight: Promise<void> = Promise.resolve();

  async function setPreferences(patch: Partial<AiPreferences>) {
    Object.assign(state.preferences, patch);
    await preferences.save({ ...state.preferences, models: { ...state.preferences.models } });
  }

  async function loadHistory() {
    try {
      state.history = await conversations.list();
    } catch {
      state.history = [];
    }
  }

  function saveNow(): Promise<void> {
    clearTimeout(saveTimer);
    const saved = snapshot();
    const keep = saved.entries.some((e) => e.role === "user") || !!saved.attached?.length || !!saved.draft?.trim();
    if (!keep && state.preferences.conversation !== saved.id) return saveInFlight;
    saveInFlight = saveInFlight
      .then(async () => {
        if (keep) {
          await conversations.save(saved);
          if (state.conversationId === saved.id) await setPreferences({ conversation: saved.id });
        } else {
          await conversations.remove(saved.id);
          if (state.preferences.conversation === saved.id) await setPreferences({ conversation: null });
        }
        state.storageError = "";
        await loadHistory();
      })
      .catch((e) => {
        state.storageError = errorText(e);
      });
    return saveInFlight;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), SAVE_DELAY_MS);
  }

  watch(() => state.draft, scheduleSave);

  async function searchHistory(query: string, cache = new Map<string, string>()): Promise<ConversationMeta[]> {
    const q = query.trim().toLowerCase();
    const list = state.history;
    if (!q) return list;
    const inTitle = (h: ConversationMeta) => h.title.toLowerCase().includes(q);
    if (q.length < 2) return list.filter(inTitle);
    const matches = await Promise.all(
      list.map(async (h) => {
        if (inTitle(h)) return true;
        if (h.id === state.conversationId) return bodyText(state.entries).includes(q);
        // keyed by update time so a chat that changed is read again
        const key = `${h.id}@${h.updatedAt}`;
        let text = cache.get(key);
        if (text === undefined) {
          const c = await conversations.load(h.id).catch(() => null);
          text = c ? bodyText(c.entries ?? []) : "";
          cache.set(key, text);
        }
        return text.includes(q);
      }),
    );
    return list.filter((_, i) => matches[i]);
  }

  return {
    setPreferences,
    saveNow,
    scheduleSave,
    async settle() {
      clearTimeout(saveTimer);
      await saveInFlight;
    },
    loadHistory,
    searchHistory,
  };
}
