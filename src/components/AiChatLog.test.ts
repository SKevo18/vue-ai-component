import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { componentAi } from "../../test/component-ai";
import type { Ai } from "../ai";
import AiChatLog from "./AiChatLog.vue";

const messages = { en: { usageIn: "{input}", usageInCached: "{input}|{cached}", usageOut: "{output}", reminder: "NUDGE", errors: { rate_limit: "BADGERS" } } };

async function mountLog(ai: Ai) {
  await ai.init();
  const w = mount(AiChatLog, { props: { ai } });
  await flushPromises();
  return w;
}

describe("AiChatLog", () => {
  it("shows compact token usage under finished replies only", async () => {
    const ai = componentAi({ messages });
    ai.state.entries = [
      { id: "u", role: "user", content: "How deep do badgers dig?" },
      { id: "a", role: "assistant", content: "Very deep.", toolCalls: [], usage: { input: 1234, output: 48, cached: 1100 } },
      { id: "b", role: "assistant", content: "Otters swim.", toolCalls: [], usage: { input: 2_500_000, output: 7 } },
      { id: "c", role: "assistant", content: "Still typ", toolCalls: [], usage: { input: 1, output: 1 }, streaming: true },
    ];
    const w = await mountLog(ai);
    const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
    expect(w.findAll(".ai-usage").map((u) => u.findAll("span").map((s) => s.text()))).toEqual([
      [`${compact(1234)}|${compact(1100)}`, "48"],
      [`${compact(2_500_000)}`, "7"],
    ]);
  });

  it("shows plan reminders as a quiet line", async () => {
    const ai = componentAi({ messages });
    ai.state.entries = [
      { id: "u", role: "user", content: "Plan the burrow" },
      { id: "r", role: "reminder", content: "Finish the plan" },
    ];
    const w = await mountLog(ai);
    expect(w.find(".ai-reminder").text()).toBe("NUDGE");
  });

  it("leads errors with a headline for their kind", async () => {
    const ai = componentAi({ messages });
    const w = await mountLog(ai);
    ai.state.error = { kind: "rate_limit", message: "Otters are queueing" };
    await flushPromises();
    expect(w.find(".ai-error-headline").text()).toBe("BADGERS");
    expect(w.find(".ai-error-text").text()).toContain("Otters are queueing");
    ai.state.error = { kind: "tools", message: "The den is closed.", failures: [] };
    await flushPromises();
    expect(w.find(".ai-error-headline").exists()).toBe(false);
    expect(w.find(".ai-error-text").text()).toBe("The den is closed.");
  });

  it("names each failing server in its own sentence and keeps the raw error for the tooltip", async () => {
    const ai = componentAi({ locale: "sk" });
    await ai.init();
    const w = mount(AiChatLog, { props: { ai }, attachTo: document.body });
    await flushPromises();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ai.state.error = { kind: "tools", message: "", failures: [{ id: "docs", name: "Docs", error: "Cannot reach the MCP server: offline" }, { id: "den", name: "den", error: "HTTP 502" }] };
    await nextTick();
    const sentences = w.findAll(".ai-error-text .ai-failure");
    expect(sentences.map((s) => s.text())).toEqual(["Nástroje zo služby Docs nie sú dostupné.", "Nástroje zo služby den nie sú dostupné."]);
    sentences[0]!.element.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".ai-tooltip")?.textContent).toBe("Cannot reach the MCP server: offline");
    w.unmount();
    vi.useRealTimers();
  });

  it("attaches a suggestion's resources to the message it sends", async () => {
    const ai = componentAi({ suggestions: [{ label: "Den", prompt: "Describe this den", resources: [{ uri: "den://7", label: "Den 7" }] }] });
    const w = await mountLog(ai);
    await w.find(".ai-suggestion").trigger("click");
    await flushPromises();
    const first = ai.state.entries[0];
    expect(first?.role === "user" && first.content).toBe("Describe this den");
    expect(first?.role === "user" && first.resources).toEqual([{ uri: "den://7", label: "Den 7" }]);
  });

  it("shows the original attachment size on a sent message chip and opens the preview", async () => {
    const ai = componentAi();
    ai.state.entries = [{ id: "u", role: "user", content: "Read this", resources: [{ uri: "attachment://notes", label: "notes.txt", size: 2048 }] }];
    const w = await mountLog(ai);
    expect(w.find(".ai-chip-size").text()).toBe("2 KiB");
    await w.find(".ai-chip-open").trigger("click");
    expect(ai.state.preview?.uri).toBe("attachment://notes");
    ai.closePreview();
    w.unmount();
  });
});
