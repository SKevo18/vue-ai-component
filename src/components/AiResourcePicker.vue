<script setup lang="ts">
import { Link2 } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Ai, PickerItem } from "../ai";
import type { ResourceRef } from "../core/entries";
import { chipIcon } from "../ui/composables";
import AiPopover from "./AiPopover.vue";

const props = defineProps<{ ai: Ai; anchor: HTMLElement | null; boundary?: HTMLElement | null; query: string }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ pick: [ref: ResourceRef] }>();
const t = props.ai.t;

const items = ref<PickerItem[]>([]);
const loading = ref(false);
const failed = ref(false);
const active = ref(0);
const list = ref<HTMLElement | null>(null);
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

const typed = computed<PickerItem | null>(() => {
  const q = props.query.trim();
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(q) ? { uri: q, label: q, group: "results" } : null;
});

const groups: PickerItem["group"][] = ["context", "resources", "skills", "results"];
const flat = computed(() => {
  const out = typed.value ? [typed.value] : [];
  for (const g of groups) for (const i of items.value) if (i.group === g && i.uri !== typed.value?.uri) out.push(i);
  return out;
});
const labels: Record<PickerItem["group"], string> = { context: "picker.context", resources: "picker.resources", skills: "picker.skills", results: "picker.results" };

function load() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  failed.value = false;
  void props.ai
    .pickerItems(props.query, signal)
    .then((found) => {
      if (signal.aborted) return;
      items.value = found;
      active.value = 0;
    })
    .catch(() => {
      if (signal.aborted) return;
      items.value = [];
      failed.value = true;
    })
    .finally(() => {
      if (!signal.aborted) loading.value = false;
    });
}

watch(
  () => [open.value, props.query] as const,
  ([isOpen], before) => {
    clearTimeout(timer);
    if (!isOpen) {
      controller?.abort();
      return;
    }
    if (!before?.[0]) load();
    else timer = setTimeout(load, 180);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  clearTimeout(timer);
  controller?.abort();
});

function pick(item: PickerItem | undefined) {
  if (!item) return;
  emit("pick", { uri: item.uri, label: item.label, icon: item.icon, ...(item.size === undefined ? {} : { size: item.size }) });
  open.value = false;
}

function move(delta: number) {
  if (!flat.value.length) return;
  active.value = (active.value + delta + flat.value.length) % flat.value.length;
  void nextTick(() => list.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }));
}

function key(e: KeyboardEvent): boolean {
  if (!open.value) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    move(e.key === "ArrowDown" ? 1 : -1);
    return true;
  }
  if ((e.key === "Enter" || e.key === "Tab") && flat.value.length) {
    pick(flat.value[active.value]);
    return true;
  }
  if (e.key === "Escape") {
    open.value = false;
    return true;
  }
  return false;
}

function showLabel(i: number): boolean {
  const item = flat.value[i]!;
  return item !== typed.value && (i === 0 || flat.value[i - 1]!.group !== item.group || flat.value[i - 1] === typed.value);
}

defineExpose({ key });
</script>

<template>
  <AiPopover v-model:open="open" :anchor="anchor" :boundary="boundary" placement="top-start" width="anchor" :label="t('mention')">
    <div ref="list" class="ai-picker" role="listbox">
      <template v-for="(item, i) in flat" :key="item.uri">
        <div v-if="showLabel(i)" class="ai-menu-label">{{ t(labels[item.group]) }}</div>
        <button
          type="button"
          role="option"
          class="ai-menu-item"
          :data-active="i === active"
          :aria-selected="i === active"
          @pointerdown.prevent
          @click="pick(item)"
          @pointerenter="active = i"
        >
          <component :is="item === typed ? Link2 : chipIcon(item.icon, item.uri)" />
          <span class="ai-picker-text">
            <span class="ai-truncate">{{ item === typed ? t("picker.uri", { uri: item.uri }) : item.label }}</span>
            <span v-if="item !== typed" class="ai-truncate ai-picker-uri">{{ item.description || item.uri }}</span>
          </span>
        </button>
      </template>
      <div v-if="failed" class="ai-picker-empty" role="alert">
        <span>{{ t("picker.error") }}</span>
        <button type="button" class="ai-btn ai-ghost ai-sm" @click="load">{{ t("retry") }}</button>
      </div>
      <div v-else-if="!flat.length" class="ai-picker-empty">
        <span v-if="loading" class="ai-spinner" />
        <span v-else>{{ t("picker.empty") }}</span>
      </div>
    </div>
  </AiPopover>
</template>

<style>
.ai-picker {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 0;
}
.ai-picker-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}
.ai-picker-uri {
  color: var(--vc-fg-faint);
  font-size: 11.5px;
}
.ai-picker-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  padding: 14px;
  color: var(--vc-fg-muted);
}
</style>
