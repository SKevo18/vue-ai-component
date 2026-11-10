import { computed, type ComputedRef } from "vue";
import type { AiBackend, AiConnection } from "../backend/types";
import { AiError, errorText } from "../core/types";
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

export function createConnections(state: AiState, backend: AiBackend, { t, init, setPreferences }: Dependencies): Connections {
  const connection = computed(() => {
    const usable = state.connections.filter((c) => c.enabled && c.connected);
    return usable.find((c) => c.id === state.preferences.connection) ?? usable[0] ?? null;
  });
  const model = computed(() => {
    const c = connection.value;
    if (!c) return "";
    return state.preferences.models[c.id] || state.models[c.id]?.items[0]?.id || "";
  });

  async function loadModels(id: string, refresh = false) {
    const current = state.models[id];
    if (current?.loading || (current?.items.length && !refresh)) return;
    state.models[id] = { items: current?.items ?? [], loading: true, error: "" };
    try {
      state.models[id] = { items: await backend.models(id), loading: false, error: "" };
    } catch (e) {
      state.models[id] = { items: current?.items ?? [], loading: false, error: errorText(e) };
    }
  }

  return {
    connection,
    model,
    loadModels,
    async refreshConnections() {
      try {
        state.connections = await backend.connections();
        state.connectionsError = "";
      } catch (e) {
        state.connectionsError = errorText(e);
      } finally {
        state.connectionsLoaded = true;
      }
      const c = connection.value;
      if (c && !state.models[c.id]?.items.length) void loadModels(c.id);
    },
    async select(id, chosen) {
      if (chosen) state.preferences.models = { ...state.preferences.models, [id]: chosen };
      await setPreferences({ connection: id });
      void loadModels(id);
    },
    async target() {
      await init();
      const c = connection.value;
      if (!c) throw new AiError("auth", t("notConnected"));
      if (!model.value) await loadModels(c.id);
      if (!model.value) throw new AiError("bad_request", state.models[c.id]?.error || t("model.none"));
      return { connection: c, model: model.value };
    },
  };
}
