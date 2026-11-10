import { createAi, type AiOptions } from "../src/ai";
import type { AiBackend, AiConnection } from "../src/backend/types";
import type { ConversationStore, StoredConversation } from "../src/stores/conversations";

export function memoryConversations(initial: StoredConversation[] = []): ConversationStore & { stored: Map<string, StoredConversation> } {
  const stored = new Map(initial.map((c) => [c.id, c]));
  return {
    stored,
    list: async () => [...stored.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    load: async (id) => structuredClone(stored.get(id) ?? null),
    save: async (c) => void stored.set(c.id, structuredClone(c)),
    remove: async (id) => void stored.delete(id),
  };
}

export function componentAi(over: Partial<AiOptions> = {}, backend: Partial<AiBackend> = {}, connections: AiConnection[] = [{ id: "otter", kind: "key", dialect: "responses", name: "Otter", connected: true, enabled: true }]) {
  return createAi({
    backend: { connections: async () => connections, models: async () => [{ id: "otter-1" }], transport: () => async () => new Response("", { status: 500 }), ...backend },
    conversations: memoryConversations(),
    preferences: { load: async () => ({}), save: async () => undefined },
    storagePrefix: "component-test:",
    ...over,
  });
}
