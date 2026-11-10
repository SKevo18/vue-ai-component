import { flushPromises, mount } from "@vue/test-utils";
import { expect, it, vi } from "vitest";
import { componentAi } from "../../test/component-ai";
import AiResourcePicker from "./AiResourcePicker.vue";

it("shows a search failure and lets the user retry without closing the picker", async () => {
  let unavailable = true;
  const ai = componentAi({ searchResources: async () => {
    if (unavailable) throw new Error("search unavailable");
    return [{ uri: "den://3", label: "Marsh den", size: 42 }];
  } });
  await ai.init();
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const w = mount(AiResourcePicker, { props: { ai, open: true, anchor, query: "marsh" }, attachTo: document.body });
  try {
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="option"]')).toBeNull();
    unavailable = false;
    const retry = document.querySelector('[role="alert"] button') as HTMLButtonElement;
    retry.click();
    await flushPromises();
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain("Marsh den"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    (document.querySelector('[role="option"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(w.emitted("pick")?.[0]).toEqual([{ uri: "den://3", label: "Marsh den", icon: undefined, size: 42 }]);
  } finally {
    w.unmount();
    anchor.remove();
  }
});
