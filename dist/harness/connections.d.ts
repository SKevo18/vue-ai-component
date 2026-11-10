import { type ComputedRef } from "vue";
import type { AiBackend, AiConnection } from "../backend/types";
import type { Translate } from "../i18n";
import type { AiPreferences } from "../stores/preferences";
import type { AiState } from "./types";
export interface Target {
    connection: AiConnection;
    model: string;
}
export interface Connections {
    connection: ComputedRef<AiConnection | null>;
    model: ComputedRef<string>;
    refreshConnections(): Promise<void>;
    loadModels(id: string, refresh?: boolean): Promise<void>;
    select(id: string, model?: string): Promise<void>;
    target(): Promise<Target>;
}
interface Dependencies {
    t: Translate;
    init(): Promise<void>;
    setPreferences(patch: Partial<AiPreferences>): Promise<void>;
}
export declare function createConnections(state: AiState, backend: AiBackend, { t, init, setPreferences }: Dependencies): Connections;
export {};
