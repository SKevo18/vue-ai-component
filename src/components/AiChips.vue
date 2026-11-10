<script setup lang="ts">
import { X } from "@lucide/vue";
import { computed, ref } from "vue";
import type { ResourceRef } from "../core/entries";
import type { Translate } from "../i18n";
import { chipIcon } from "../ui/composables";
import { vTooltip } from "../ui/tooltip";

const COLLAPSED = 3;

const props = defineProps<{ items: ResourceRef[]; t: Translate; removable?: boolean }>();
const emit = defineEmits<{ open: [ref: ResourceRef]; remove: [ref: ResourceRef] }>();
const expanded = ref(false);
/** one hidden chip is shown instead of a "+1" button that would save nothing */
const shown = computed(() => (expanded.value || props.items.length <= COLLAPSED + 1 ? props.items : props.items.slice(0, COLLAPSED)));
const hidden = computed(() => props.items.length - shown.value.length);

function sizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Number((size / 1024).toFixed(1))} KiB`;
  return `${Number((size / (1024 * 1024)).toFixed(1))} MiB`;
}
</script>

<template>
  <span v-for="c in shown" :key="c.uri" class="ai-chip">
    <button v-tooltip="c.uri" type="button" class="ai-chip-open" @click="emit('open', c)">
      <component :is="chipIcon(c.icon, c.uri)" />
      <span class="ai-truncate">{{ c.label }}</span>
      <span v-if="c.size !== undefined && Number.isFinite(c.size) && c.size >= 0" class="ai-chip-size">{{ sizeLabel(c.size) }}</span>
    </button>
    <button v-if="removable" v-tooltip="t('remove')" type="button" @click="emit('remove', c)"><X /></button>
  </span>
  <button v-if="hidden > 0" v-tooltip="items.slice(COLLAPSED).map((r) => r.label).join(', ')" type="button" class="ai-chip ai-chip-more" :aria-label="t('moreChipsLabel', { count: hidden })" @click="expanded = true">
    {{ t("moreChips", { count: hidden }) }}
  </button>
  <button v-else-if="expanded && items.length > COLLAPSED + 1" type="button" class="ai-chip ai-chip-more" @click="expanded = false">{{ t("fewerChips") }}</button>
</template>

<style>
.ai-chip .ai-chip-open {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.ai-chip .ai-chip-open:hover {
  background: none;
  color: var(--vc-fg-strong);
}
.ai-chip .ai-chip-open svg {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--vc-fg-muted);
}
.ai-chip.ai-chip-more {
  padding: 0 8px;
  color: var(--vc-fg-muted);
}
.ai-chip-size {
  flex: none;
  color: var(--vc-fg-muted);
  font-size: 10px;
}
</style>
