import type { ConversationMeta, ConversationStore, StoredConversation } from "../stores/conversations";
import type { AiPreferences, PreferencesStore } from "../stores/preferences";
import type { AiState } from "./types";
export interface Persistence {
    setPreferences(patch: Partial<AiPreferences>): Promise<void>;
    saveNow(): Promise<void>;
    scheduleSave(): void;
    settle(): Promise<void>;
    loadHistory(): Promise<void>;
    searchHistory(query: string, cache?: Map<string, string>): Promise<ConversationMeta[]>;
}
export declare function createPersistence(state: AiState, conversations: ConversationStore, preferences: PreferencesStore, snapshot: () => StoredConversation): Persistence;
