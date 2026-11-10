export interface AiPreferences {
    connection: string | null;
    models: Record<string, string>;
    autoApproveWrites: boolean;
    autoApproveExternal: boolean;
    conversation: string | null;
}
export declare const DEFAULT_PREFERENCES: AiPreferences;
export interface PreferencesStore {
    load(): Promise<Partial<AiPreferences>>;
    save(preferences: AiPreferences): Promise<void>;
}
/** one JSON value under `<prefix>preferences` */
export declare function createLocalPreferencesStore(options?: {
    prefix?: string;
    storage?: Storage;
}): PreferencesStore;
