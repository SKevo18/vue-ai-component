import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import AiChips from "./AiChips.vue";

const { t } = createTranslator("en");
const chips = (n: number) => Array.from({ length: n }, (_, i) => ({ uri: `burrow://${i + 1}`, label: `Burrow ${i + 1}` }));
const labels = (w: ReturnType<typeof mount>) => w.findAll(".ai-chip-open").map((c) => c.text());

describe("AiChips", () => {
  it("collapses beyond three chips behind +N and expands on click", async () => {
    const w = mount(AiChips, { props: { items: chips(6), t } });
    expect(labels(w)).toEqual(["Burrow 1", "Burrow 2", "Burrow 3"]);
    await w.find(".ai-chip-more").trigger("click");
    expect(labels(w)).toHaveLength(6);
    expect(w.find(".ai-chip-more").text()).toBe("Less");
    await w.find(".ai-chip-more").trigger("click");
    expect(labels(w)).toHaveLength(3);
  });

  it("shows four chips instead of a +1 button", () => {
    const w = mount(AiChips, { props: { items: chips(4), t } });
    expect(labels(w)).toHaveLength(4);
    expect(w.find(".ai-chip-more").exists()).toBe(false);
  });

  it("emits open and remove with the chip", async () => {
    const w = mount(AiChips, { props: { items: chips(2), t, removable: true } });
    await w.findAll(".ai-chip-open")[1]!.trigger("click");
    await w.findAll(".ai-chip > button:not(.ai-chip-open)")[0]!.trigger("click");
    expect(w.emitted("open")![0]).toEqual([{ uri: "burrow://2", label: "Burrow 2" }]);
    expect(w.emitted("remove")![0]).toEqual([{ uri: "burrow://1", label: "Burrow 1" }]);
  });

  it("shows known file sizes on removable and sent chips without changing open metadata", async () => {
    const items = [
      { uri: "attachment://empty", label: "empty.txt", size: 0 },
      { uri: "attachment://notes", label: "notes.txt", size: 1536 },
      { uri: "attachment://photo", label: "photo.png", size: 2 * 1024 * 1024 },
      { uri: "note://den", label: "Den" },
    ];
    for (const removable of [false, true]) {
      const w = mount(AiChips, { props: { items, t, removable } });
      expect(w.findAll(".ai-chip-size").map((c) => c.text())).toEqual(["0 B", "1.5 KiB", "2 MiB"]);
      await w.findAll(".ai-chip-open")[1]!.trigger("click");
      expect(w.emitted("open")![0]).toEqual([items[1]]);
      w.unmount();
    }
  });
});
