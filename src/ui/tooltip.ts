import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { Directive } from "vue";

export type TooltipValue = string | { text: string; keys?: string } | null | undefined;

interface State {
  value: TooltipValue;
  show: () => void;
  hide: () => void;
  onPointer: (e: PointerEvent) => void;
}

const states = new WeakMap<HTMLElement, State>();
let tip: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let stopUpdate: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastPointer = "mouse";

function element(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "ai-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

function hide() {
  clearTimeout(timer);
  stopUpdate?.();
  stopUpdate = null;
  owner = null;
  if (tip) tip.hidden = true;
}

function show(el: HTMLElement, value: TooltipValue) {
  const text = typeof value === "string" ? value : value?.text;
  if (!text || lastPointer === "touch") return;
  const keys = typeof value === "object" && value ? value.keys : undefined;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const t = element();
    t.textContent = text;
    if (keys) {
      const k = document.createElement("kbd");
      k.textContent = keys;
      t.append(" ", k);
    }
    t.hidden = false;
    owner = el;
    stopUpdate?.();
    stopUpdate = autoUpdate(el, t, () => {
      void computePosition(el, t, { placement: "bottom", strategy: "fixed", middleware: [offset(6), flip(), shift({ padding: 6 })] }).then(({ x, y }) => {
        Object.assign(t.style, { left: `${x}px`, top: `${y}px` });
      });
    });
  }, 350);
}

export const vTooltip: Directive<HTMLElement, TooltipValue> = {
  mounted(el, binding) {
    const state: State = {
      value: binding.value,
      show: () => show(el, state.value),
      hide,
      onPointer: (e) => {
        lastPointer = e.pointerType;
      },
    };
    states.set(el, state);
    const label = typeof binding.value === "string" ? binding.value : binding.value?.text;
    if (label && !el.getAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", label);
    el.addEventListener("pointerdown", state.onPointer);
    el.addEventListener("pointerenter", state.onPointer);
    el.addEventListener("mouseenter", state.show);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focusin", state.show);
    el.addEventListener("focusout", hide);
    el.addEventListener("click", hide);
  },
  updated(el, binding) {
    const state = states.get(el);
    if (!state) return;
    state.value = binding.value;
    const label = typeof binding.value === "string" ? binding.value : binding.value?.text;
    if (label && !el.textContent?.trim()) el.setAttribute("aria-label", label);
    if (owner === el && tip) tip.firstChild!.textContent = label ?? "";
  },
  unmounted(el) {
    const state = states.get(el);
    if (!state) return;
    el.removeEventListener("pointerdown", state.onPointer);
    el.removeEventListener("pointerenter", state.onPointer);
    el.removeEventListener("mouseenter", state.show);
    el.removeEventListener("mouseleave", hide);
    el.removeEventListener("focusin", state.show);
    el.removeEventListener("focusout", hide);
    el.removeEventListener("click", hide);
    if (owner === el) hide();
    states.delete(el);
  },
};
