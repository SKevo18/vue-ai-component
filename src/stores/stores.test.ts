import { beforeEach, describe, expect, it } from "vitest";
import { createLocalConversationStore } from "./conversations";
import { createLocalPreferencesStore } from "./preferences";

beforeEach(() => localStorage.clear());

const conversation = (id: string, updatedAt: number) => ({ id, title: `burrow ${id}`, updatedAt, entries: [{ id: "u", role: "user" as const, content: "hi otter" }] });

describe("local conversation store", () => {
  it("lists newest first and drops the oldest bodies beyond the limit", async () => {
    const store = createLocalConversationStore({ prefix: "t:", max: 2 });
    await store.save(conversation("a", 1));
    await store.save(conversation("b", 3));
    await store.save(conversation("c", 2));
    expect((await store.list()).map((m) => m.id)).toEqual(["b", "c"]);
    expect(await store.load("a")).toBeNull();
    expect(localStorage.getItem("t:conversation:a")).toBeNull();
    expect((await store.load("c"))?.entries[0]).toMatchObject({ content: "hi otter" });
  });

  it("removes a conversation and its index entry", async () => {
    const store = createLocalConversationStore({ prefix: "t:" });
    await store.save(conversation("a", 1));
    await store.remove("a");
    expect(await store.list()).toEqual([]);
    expect(await store.load("a")).toBeNull();
  });
});

describe("local preferences store", () => {
  it("round-trips and survives corrupt values", async () => {
    const store = createLocalPreferencesStore({ prefix: "t:" });
    await store.save({ connection: "otter-plan", models: { "otter-plan": "gpt-otter" }, autoApproveWrites: true, autoApproveExternal: false, conversation: null });
    expect(await store.load()).toMatchObject({ connection: "otter-plan", models: { "otter-plan": "gpt-otter" } });
    localStorage.setItem("t:preferences", "{badger");
    expect(await store.load()).toEqual({});
  });
});
