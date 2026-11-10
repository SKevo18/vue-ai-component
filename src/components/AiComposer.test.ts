import "fake-indexeddb/auto";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { componentAi, memoryConversations } from "../../test/component-ai";
import AiComposer from "./AiComposer.vue";
import { PASTE_ATTACHMENT_THRESHOLD } from "../core/attachments";
import type { AiPreferences } from "../stores/preferences";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AiComposer", () => {
  it("lists tools allowed for the chat and resets them", async () => {
    const conversations = memoryConversations();
    const ai = componentAi({ conversations });
    await ai.init();
    ai.state.entries = [{ id: "u", role: "user", content: "Feed the otters" }];
    ai.state.allowedTools = ["feed_otter", "dig_burrow"];
    ai.state.toolTitles = { dig_burrow: "Dig a burrow" };
    const w = mount(AiComposer, { props: { ai } });
    await flushPromises();
    const notice = w.find(".ai-allowed");
    expect(notice.text()).toContain("Feed otter");
    expect(notice.text()).toContain("Dig a burrow");
    vi.useFakeTimers();
    await notice.find("button").trigger("click");
    expect(ai.state.allowedTools).toEqual([]);
    expect(w.find(".ai-allowed").exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(conversations.stored.get(ai.state.conversationId)?.allowedTools).toEqual([]);
  });

  it("inserts an @ at the caret from the mention button and removes it on Escape", async () => {
    const ai = componentAi();
    await ai.init();
    const w = mount(AiComposer, { props: { ai }, attachTo: document.body });
    await flushPromises();
    const area = w.find("textarea").element as HTMLTextAreaElement;
    ai.state.draft = "feed the otters";
    await flushPromises();
    area.setSelectionRange(8, 8);
    await w.find("button[aria-pressed]").trigger("click");
    await flushPromises();
    expect(ai.state.draft).toBe("feed the @ otters");
    expect(area.selectionStart).toBe(10);
    expect(w.find("button[aria-pressed]").attributes("aria-pressed")).toBe("true");
    await w.find("textarea").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(ai.state.draft).toBe("feed the  otters");
    w.unmount();
  });

  it("does not add a space before the @ at the start of a word", async () => {
    const ai = componentAi();
    await ai.init();
    const w = mount(AiComposer, { props: { ai }, attachTo: document.body });
    await flushPromises();
    await w.find("button[aria-pressed]").trigger("click");
    await flushPromises();
    expect(ai.state.draft).toBe("@");
    w.unmount();
  });

  it("prefills the draft with compose and focuses the end", async () => {
    const ai = componentAi();
    await ai.init();
    const w = mount(AiComposer, { props: { ai }, attachTo: document.body });
    await flushPromises();
    ai.state.draft = "Badgers";
    await ai.compose("and otters", { resources: [{ uri: "den://1", label: "Den" }] });
    await flushPromises();
    const area = w.find("textarea").element as HTMLTextAreaElement;
    expect(ai.state.draft).toBe("Badgers and otters");
    expect(ai.chips.map((c) => c.uri)).toEqual(["den://1"]);
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe("Badgers and otters".length);
    w.unmount();
  });

  it("sends a composed message with its resources", async () => {
    const ai = componentAi();
    await ai.init();
    await ai.compose("Count the otters", { resources: [{ uri: "river://2", label: "River" }], send: true });
    const first = ai.state.entries[0];
    expect(first?.role === "user" && first.content).toBe("Count the otters");
    expect(first?.role === "user" && first.resources).toEqual([{ uri: "river://2", label: "River" }]);
    expect(ai.state.draft).toBe("");
  });

  it("inserts a selected resource URI at the caret without losing surrounding text", async () => {
    const ai = componentAi({ context: [{ uri: "den://2", label: "Burrow" }] });
    await ai.init();
    const w = mount(AiComposer, { props: { ai }, attachTo: document.body });
    ai.state.draft = "Compare @ with otters";
    await flushPromises();
    const area = w.find("textarea").element as HTMLTextAreaElement;
    area.setSelectionRange(9, 9);
    await w.find("textarea").trigger("input");
    await flushPromises();
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(ai.state.draft).toBe("Compare den://2 with otters");
    expect(area.selectionStart).toBe(15);
    expect(ai.state.entries).toEqual([]);
    w.unmount();
  });

  it("attaches a long paste once and inserts its URI in place of the selection", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("File", NodeFile);
    const ai = componentAi({ storagePrefix: "long-paste-regression:" });
    await ai.init();
    const w = mount(AiComposer, { props: { ai }, attachTo: document.body });
    ai.state.draft = "Read placeholder please";
    await flushPromises();
    const area = w.find("textarea").element as HTMLTextAreaElement;
    area.setSelectionRange(5, 16);
    const pasted = "otter ".repeat(Math.ceil(PASTE_ATTACHMENT_THRESHOLD / 6) + 1);
    await w.find("textarea").trigger("paste", { clipboardData: { files: [], getData: () => pasted } });
    await vi.waitFor(() => expect(ai.state.draft).toMatch(/^Read attachment:\/\/[\w-]+ please$/));
    const files = await ai.files();
    expect(files).toHaveLength(1);
    expect(await files[0]!.blob.text()).toBe(pasted);
    expect(ai.state.draft).not.toContain("placeholder");
    await ai.removeAllChats();
    w.unmount();
  });

  it("restores unsent text and files after leaving before the autosave delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("File", NodeFile);
    const conversations = memoryConversations();
    let prefs: Partial<AiPreferences> = {};
    const preferences = { load: async () => prefs, save: async (value: AiPreferences) => { prefs = value; } };
    const create = () => componentAi({ conversations, preferences, storagePrefix: "pagehide-draft-regression:" });
    const ai = create();
    await ai.init();
    const w = mount(AiComposer, { props: { ai } });
    const ref = await ai.attachText("The otters counted three badgers.", "census.txt");
    await w.find("textarea").setValue(`Compare ${ref!.uri} with last year.`);
    window.dispatchEvent(new Event("pagehide"));
    await flushPromises();
    const restored = create();
    await restored.init();
    expect(restored.state.draft).toBe(`Compare ${ref!.uri} with last year.`);
    expect(restored.chips.map((chip) => chip.uri)).toEqual([ref!.uri]);
    expect(await (await restored.files())[0]!.blob.text()).toBe("The otters counted three badgers.");
    w.unmount();
    await ai.removeAllChats();
  });
});
