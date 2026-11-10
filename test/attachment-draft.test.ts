// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { componentAi, memoryConversations } from "./component-ai";
import type { AiPreferences } from "../src/stores/preferences";

afterEach(() => vi.useRealTimers());

it("restores unsent attachment chips and bytes, then persists removing the last chip", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const conversations = memoryConversations();
  let prefs: Partial<AiPreferences> = {};
  const preferences = { load: async () => prefs, save: async (value: AiPreferences) => { prefs = value; } };
  const create = () => componentAi({ conversations, preferences, storagePrefix: "unsent-attachment-test:" });
  const ai = create();
  await ai.init();
  const attached = await ai.attachText("Three otters in the marsh", "census.txt");
  const restored = create();
  await restored.init();
  expect(restored.state.entries).toEqual([]);
  expect(restored.chips.map((chip) => chip.uri)).toEqual([attached!.uri]);
  expect(await (await restored.files())[0]!.blob.text()).toBe("Three otters in the marsh");
  restored.detach(attached!.uri);
  await vi.advanceTimersByTimeAsync(1000);
  const empty = create();
  await empty.init();
  expect(empty.chips).toEqual([]);
  expect(await conversations.list()).toEqual([]);
  await empty.removeAllChats();
});

it("waits for a pending save before deleting the current conversation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const conversations = memoryConversations([{ id: "marsh", title: "Marsh", updatedAt: 1, entries: [{ id: "u", role: "user", content: "Count otters" }] }]);
  const write = conversations.save;
  const gate = Promise.withResolvers<void>();
  conversations.save = async (value) => { await gate.promise; await write(value); };
  const ai = componentAi({ conversations });
  await ai.init();
  await ai.openChat("marsh");
  ai.setChatAutoApprove(true);
  await vi.advanceTimersByTimeAsync(800);
  let removed = false;
  const removal = ai.removeChat("marsh").then(() => { removed = true; });
  await Promise.resolve();
  expect(removed).toBe(false);
  gate.resolve();
  await removal;
  expect(await conversations.load("marsh")).toBeNull();
  expect(ai.state.entries).toEqual([]);
});

it("reports a failed save and clears the report after the next one succeeds", async () => {
  const conversations = memoryConversations();
  const write = conversations.save;
  conversations.save = async () => { throw new Error("Quota exceeded"); };
  const ai = componentAi({ conversations });
  await ai.init();
  ai.state.draft = "Count the otters";
  await ai.flush();
  expect(ai.state.storageError).toBe("Quota exceeded");
  conversations.save = write;
  await ai.flush();
  expect(ai.state.storageError).toBe("");
});

it("reports attachments that could not be deleted with their chat", async () => {
  const conversations = memoryConversations([{ id: "marsh", title: "Marsh", updatedAt: 1, entries: [{ id: "u", role: "user", content: "Count otters" }] }]);
  const ai = componentAi({ conversations });
  await ai.init();
  vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new Error("Disk full"); });
  await ai.removeChat("marsh");
  vi.restoreAllMocks();
  expect(await conversations.load("marsh")).toBeNull();
  expect(ai.state.storageError).toBe("Disk full");
});
