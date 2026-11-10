import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { componentAi } from "../../test/component-ai";
import type { ToolEntry } from "../core/entries";
import AiToolCard from "./AiToolCard.vue";

const entry = (over: Partial<ToolEntry>): ToolEntry => ({ id: "t", role: "tool", toolCallId: "c", name: "count_otters", args: {}, content: "", status: "done", ...over });

describe("AiToolCard", () => {
  it("previews the start of a successful result while collapsed", async () => {
    const content = `Otters:\n${"badger ".repeat(60)}`;
    const w = mount(AiToolCard, { props: { entry: entry({ content }), ai: componentAi() } });
    const preview = w.find(".ai-tool-preview").text();
    expect(preview.startsWith("Otters: badger badger")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(120);
    await w.find(".ai-tool-head").trigger("click");
    expect(w.find(".ai-tool-preview").exists()).toBe(false);
  });

  it("shows no preview for failed calls", () => {
    const w = mount(AiToolCard, { props: { entry: entry({ content: "The river is frozen", isError: true, status: "error" }), ai: componentAi() } });
    expect(w.find(".ai-tool-preview").exists()).toBe(false);
  });

  it("pretty-prints JSON results when open and leaves other text alone", async () => {
    const w = mount(AiToolCard, { props: { entry: entry({ content: '{"otters":[{"name":"Ollie"}],"badgers":2}' }), ai: componentAi() } });
    await w.find(".ai-tool-head").trigger("click");
    expect(w.find(".ai-tool-result").text()).toBe(JSON.stringify({ otters: [{ name: "Ollie" }], badgers: 2 }, null, 2));
    await w.setProps({ entry: entry({ content: "{not json, badger" }) });
    expect(w.find(".ai-tool-result").text()).toBe("{not json, badger");
  });
});
