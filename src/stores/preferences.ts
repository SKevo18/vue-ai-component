export interface AiPreferences {
  connection: string | null;
  models: Record<string, string>;
  autoApproveWrites: boolean;
  autoApproveExternal: boolean;
  conversation: string | null;
}

export const DEFAULT_PREFERENCES: AiPreferences = { connection: null, models: {}, autoApproveWrites: false, autoApproveExternal: false, conversation: null };

export interface PreferencesStore {
  load(): Promise<Partial<AiPreferences>>;
  save(preferences: AiPreferences): Promise<void>;
}

/** one JSON value under `<prefix>preferences` */
export function createLocalPreferencesStore(options: { prefix?: string; storage?: Storage } = {}): PreferencesStore {
  const key = `${options.prefix ?? "ai:"}preferences`;
  const storage = () => options.storage ?? globalThis.localStorage;
  return {
    async load() {
      try {
        const raw = storage()?.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return parsed && typeof parsed === "object" ? (parsed as Partial<AiPreferences>) : {};
      } catch {
        return {};
      }
    },
    async save(preferences) {
      try {
        storage()?.setItem(key, JSON.stringify(preferences));
      } catch {
        // private mode quota: preferences then last for this page only
      }
    },
  };
}
