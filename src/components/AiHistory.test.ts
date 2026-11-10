import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { componentAi, memoryConversations } from "../../test/component-ai";
import type { StoredConversation } from "../stores/conversations";
import AiHistory from "./AiHistory.vue";

const chat = (id: string, title: string, user: string, assistant: string, updatedAt: number): StoredConversation => ({
  id,
  title,
  updatedAt,
  entries: [
    { id: `${id}u`, role: "user", content: user },
    { id: `${id}a`, role: "assistant", content: assistant, toolCalls: [] },
    { id: `${id}t`, role: "tool", toolCallId: "c", name: "dig", args: {}, content: "secret marmot", status: "done" },
  ],
});

const settle = async () => {
  await vi.advanceTimersByTimeAsync(250);
  await flushPromises();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AiHistory", () => {
  it("finds chats by message text once the query has two characters, loading each body once", async () => {
    const conversations = memoryConversations([
      chat("a", "River trip", "Where do otters sleep?", "In holts by the river.", 3),
      chat("b", "Garden", "Badgers dug up the lawn", "Try a fence.", 2),
      chat("c", "Holt plans", "Draw a den", "Here is a sketch.", 1),
    ]);
    const load = vi.spyOn(conversations, "load");
    const ai = componentAi({ conversations });
    await ai.init();
    const w = mount(AiHistory, { props: { ai } });
    await flushPromises();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const titles = () => w.findAll(".ai-history-title").map((t) => t.text());
    const input = w.find("input[type=search]");

    await input.setValue("holt");
    expect(titles()).toEqual(["Holt plans"]);
    await settle();
    expect(titles()).toEqual(["River trip", "Holt plans"]);

    await input.setValue("lawn");
    await settle();
    expect(titles()).toEqual(["Garden"]);

    await input.setValue("marmot");
    await settle();
    expect(titles()).toEqual([]);

    await input.setValue("w");
    await settle();
    expect(titles()).toEqual([]);
    expect(load.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b", "c"]);
  });

  it("deletes the open chat without saving it again when starting the replacement", async () => {
    const conversations = memoryConversations([
      chat("a", "River trip", "Where do otters sleep?", "In holts.", 2),
      chat("b", "Garden", "Badgers dug up the lawn", "Try a fence.", 1),
    ]);
    const ai = componentAi({ conversations });
    await ai.init();
    await ai.openChat("a");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ai.setChatAutoApprove(true);
    await ai.removeChat("a");
    await vi.advanceTimersByTimeAsync(1000);
    await ai.newChat();
    expect([...conversations.stored.keys()]).toEqual(["b"]);
    expect(ai.state.conversationId).not.toBe("a");
    expect(ai.state.entries).toEqual([]);
    expect(ai.state.history.map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps the open chat when deleting a different conversation", async () => {
    const conversations = memoryConversations([
      chat("a", "River trip", "Where do otters sleep?", "In holts.", 2),
      chat("b", "Garden", "Badgers dug up the lawn", "Try a fence.", 1),
    ]);
    const ai = componentAi({ conversations });
    await ai.init();
    await ai.openChat("a");
    await ai.removeChat("b");
    expect(ai.state.conversationId).toBe("a");
    expect(ai.state.entries[0]).toMatchObject({ content: "Where do otters sleep?" });
    expect([...conversations.stored.keys()]).toEqual(["a"]);
  });
});
