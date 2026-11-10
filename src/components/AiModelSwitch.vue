<script setup lang="ts">
import { Check, ChevronDown, Search, Settings } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import type { Ai } from "../ai";
import { useAiInstance } from "../ui/composables";
import { vTooltip } from "../ui/tooltip";
import AiPopover from "./AiPopover.vue";

const props = defineProps<{ ai?: Ai; boundary?: HTMLElement | null }>();
const ai = useAiInstance(props);
const t = ai.t;
const state = ai.state;

const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const query = ref("");
const browsing = ref<string | null>(null);

const usable = computed(() => state.connections.filter((c) => c.enabled && c.connected));
const shown = computed(() => browsing.value ?? ai.connection?.id ?? null);
const list = computed(() => (shown.value ? state.models[shown.value] : undefined));
const models = computed(() => {
  const q = query.value.trim().toLowerCase();
  const items = list.value?.items ?? [];
  return q ? items.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)) : items;
});
const custom = computed(() => {
  const q = query.value.trim();
  return q && /^[\w.:/@-]+$/.test(q) && !models.value.some((m) => m.id === q) ? q : "";
});
const label = computed(() => {
  const c = ai.connection;
  if (!c) return t("model.choose");
  const m = state.models[c.id]?.items.find((x) => x.id === ai.model);
  return m?.name || ai.model || c.name;
});

watch(open, async (v) => {
  if (!v) return;
  browsing.value = null;
  query.value = "";
  if (ai.connection) void ai.loadModels(ai.connection.id);
  await nextTick();
  search.value?.focus({ preventScroll: true });
});

function browse(id: string) {
  browsing.value = id;
  query.value = "";
  void ai.loadModels(id);
}

function pick(model: string) {
  open.value = false;
  if (shown.value) void ai.select(shown.value, model);
}

function settings() {
  open.value = false;
  ai.options.openSettings?.();
}
</script>

<template>
  <button
    ref="anchor"
    v-tooltip="ai.connection ? `${ai.connection.name}: ${label}` : t('model.label')"
    type="button"
    class="ai-model-switch"
    :aria-label="`${t('model.label')}: ${label}`"
    :aria-expanded="open"
    :disabled="!usable.length"
    @click="open = !open"
  >
    <span class="ai-truncate ai-model-name">{{ label }}</span>
    <ChevronDown class="ai-model-chevron" />
  </button>
  <AiPopover v-model:open="open" :anchor="anchor" :boundary="boundary" placement="bottom-end" width="300px" :label="t('model.label')">
    <div v-if="usable.length > 1 || ai.options.openSettings" class="ai-model-tabs">
      <button v-for="c in usable" :key="c.id" type="button" class="ai-model-tab" :aria-pressed="c.id === shown" @click="browse(c.id)">{{ c.name }}</button>
      <button v-if="ai.options.openSettings" v-tooltip="t('settings')" type="button" class="ai-icon-btn ai-sm ai-model-settings" @click="settings"><Settings /></button>
    </div>
    <label class="ai-model-search">
      <Search />
      <input ref="search" v-model="query" :placeholder="t('model.search')" :aria-label="t('model.search')" @keydown.enter.prevent="(models[0] && pick(models[0].id)) || (custom && pick(custom))" />
    </label>
    <div class="ai-model-list" role="listbox">
      <div v-if="list?.loading && !list.items.length" class="ai-picker-empty"><span class="ai-spinner" /></div>
      <div v-else-if="list?.error" class="ai-model-error">{{ list.error }}</div>
      <button v-for="m in models" :key="m.id" type="button" role="option" class="ai-menu-item" :aria-selected="shown === ai.connection?.id && m.id === ai.model" @click="pick(m.id)">
        <span class="ai-picker-text">
          <span class="ai-truncate">{{ m.name || m.id }}</span>
          <span v-if="m.name && m.name !== m.id" class="ai-truncate ai-picker-uri">{{ m.id }}</span>
        </span>
        <Check v-if="shown === ai.connection?.id && m.id === ai.model" class="ai-model-check" />
      </button>
      <button v-if="custom" type="button" class="ai-menu-item" @click="pick(custom)">{{ t("model.custom", { model: custom }) }}</button>
      <div v-if="!list?.loading && !list?.error && !models.length && !custom" class="ai-picker-empty">{{ t("model.none") }}</div>
    </div>
  </AiPopover>
</template>

<style>
.ai-model-switch {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 50%;
  height: 30px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--vc-radius-sm);
  background: transparent;
  color: var(--vc-fg-muted);
  font-size: 12.5px;
  cursor: pointer;
}
.ai-model-switch:hover:not(:disabled) {
  background: var(--vc-bg-muted);
  color: var(--vc-fg-strong);
}
.ai-model-name {
  flex: 0 1 auto;
}
.ai-model-chevron {
  width: 14px;
  height: 14px;
  flex: none;
}
.ai-model-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid var(--vc-border);
}
.ai-model-tab {
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--vc-radius-sm);
  background: transparent;
  color: var(--vc-fg-muted);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.ai-model-tab:hover,
.ai-model-tab[aria-pressed="true"] {
  background: var(--vc-bg-muted);
  color: var(--vc-fg-strong);
}
.ai-model-settings {
  margin-left: auto;
}
.ai-model-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border-bottom: 1px solid var(--vc-border);
  color: var(--vc-fg-faint);
}
.ai-model-search svg {
  width: 14px;
  height: 14px;
  flex: none;
}
.ai-model-search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--vc-fg-strong);
  font: inherit;
  outline: none;
}
.ai-model-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 0;
}
.ai-model-check {
  color: var(--vc-accent) !important;
}
.ai-model-error {
  padding: 10px;
  color: var(--vc-danger);
}
</style>
