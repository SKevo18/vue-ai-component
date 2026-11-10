import type { AiBackend } from "./types";
export type KeyProvider = "openai" | "anthropic" | "gemini";
export interface BrowserKeysOptions {
    /** default `ai:`; keys live under `<prefix>key:<provider>` */
    prefix?: string;
    storage?: Storage;
    providers?: KeyProvider[];
    fetch?: typeof fetch;
    baseUrls?: Partial<Record<KeyProvider, string>>;
}
export interface BrowserKeys extends AiBackend {
    saveKey(id: string, key: string | null): Promise<void>;
    clearBrowserKeys(): Promise<void>;
}
export declare function createBrowserKeys(options?: BrowserKeysOptions): BrowserKeys;
/** each id goes to the first backend that lists it; a backend that fails to list is skipped unless all fail */
export declare function mergeBackends(...backends: AiBackend[]): AiBackend;
