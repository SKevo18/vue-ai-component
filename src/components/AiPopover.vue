<script setup lang="ts">
import { autoUpdate, computePosition, flip, offset, shift, size, type Placement } from "@floating-ui/dom";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    anchor: HTMLElement | null;
    placement?: Placement;
    width?: string;
    boundary?: HTMLElement | null;
    label?: string;
  }>(),
  { placement: "bottom-start", width: "280px", boundary: null, label: undefined },
);
const open = defineModel<boolean>("open", { required: true });
const el = ref<HTMLElement | null>(null);
let stop: (() => void) | null = null;

function place() {
  const anchor = props.anchor;
  const pop = el.value;
  if (!anchor || !pop) return;
  void computePosition(anchor, pop, {
    placement: props.placement,
    strategy: "fixed",
    middleware: [
      offset(6),
      flip({ boundary: props.boundary ?? "clippingAncestors", padding: 6 }),
      shift({ padding: 6, boundary: props.boundary ?? "clippingAncestors" }),
      size({
        padding: 6,
        boundary: props.boundary ?? "clippingAncestors",
        apply({ availableHeight, availableWidth, rects }) {
          pop.style.maxHeight = `${Math.max(120, Math.min(availableHeight, 420))}px`;
          pop.style.maxWidth = `${Math.max(180, availableWidth)}px`;
          if (props.width === "anchor") pop.style.width = `${rects.reference.width}px`;
        },
      }),
    ],
  }).then(({ x, y }) => Object.assign(pop.style, { left: `${x}px`, top: `${y}px` }));
}

function onPointer(e: PointerEvent) {
  const target = e.target as Node;
  if (el.value?.contains(target) || props.anchor?.contains(target)) return;
  open.value = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  open.value = false;
  props.anchor?.focus();
}

watch(
  open,
  async (v) => {
    stop?.();
    stop = null;
    document.removeEventListener("pointerdown", onPointer, true);
    if (!v) return;
    await nextTick();
    if (!el.value || !props.anchor) return;
    stop = autoUpdate(props.anchor, el.value, place);
    document.addEventListener("pointerdown", onPointer, true);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stop?.();
  document.removeEventListener("pointerdown", onPointer, true);
});

defineExpose({ update: place });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="el"
      class="ai-root ai-popover"
      role="dialog"
      :aria-label="label"
      :style="{ width: width === 'anchor' ? undefined : width, left: '0px', top: '0px' }"
      @keydown="onKey"
    >
      <slot />
    </div>
  </Teleport>
</template>
