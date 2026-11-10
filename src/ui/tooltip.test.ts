import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref, withDirectives } from "vue";
import { vTooltip } from "./tooltip";

const open = ref(true);
const Host = defineComponent(() => () => (open.value ? withDirectives(h("button", { type: "button" }, "x"), [[vTooltip, "Close"]]) : null));

function tooltip(): HTMLElement | null {
  return document.querySelector(".ai-tooltip");
}

describe("v-tooltip", () => {
  afterEach(() => {
    vi.useRealTimers();
    open.value = true;
  });

  it("never shows for a button removed before the hover delay ran out", async () => {
    vi.useFakeTimers();
    const wrapper = mount(Host, { attachTo: document.body });
    wrapper.find("button").element.dispatchEvent(new MouseEvent("mouseenter"));
    open.value = false;
    await nextTick();
    vi.advanceTimersByTime(1000);
    expect(tooltip()?.hidden ?? true).toBe(true);
    wrapper.unmount();
  });

  it("shows after the delay while the button stays", async () => {
    vi.useFakeTimers();
    const wrapper = mount(Host, { attachTo: document.body });
    wrapper.find("button").element.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);
    expect(tooltip()?.hidden).toBe(false);
    expect(tooltip()?.textContent).toBe("Close");
    wrapper.unmount();
    expect(tooltip()?.hidden).toBe(true);
  });
});
