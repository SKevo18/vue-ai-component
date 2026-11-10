<script setup lang="ts">
import { ArrowLeft, History, Settings, SquarePen, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ai } from "../ai";
import { serverErrors } from "../mcp/servers";
import { useAiInstance, useMediaQuery, useScrollLock, useVisualViewport } from "../ui/composables";
import { vTooltip } from "../ui/tooltip";
import AiChatLog from "./AiChatLog.vue";
import AiComposer from "./AiComposer.vue";
import AiHistory from "./AiHistory.vue";
import AiModelSwitch from "./AiModelSwitch.vue";
import AiResourcePreview from "./AiResourcePreview.vue";

const props = withDefaults(
  defineProps<{
    ai?: Ai;
    /** below this width (px) the sidebar is a full-screen sheet */
    breakpoint?: number;
    title?: string;
  }>(),
  { ai: undefined, breakpoint: 1024, title: undefined },
);
const open = defineModel<boolean>("open", { default: true });
const emit = defineEmits<{ width: [px: number] }>();
const ai = useAiInstance(props);
const t = ai.t;
const state = ai.state;

const root = ref<HTMLElement | null>(null);
const composer = ref<InstanceType<typeof AiComposer> | null>(null);
const historyOpen = ref(false);
const dragging = ref(false);
const docked = useMediaQuery(`(min-width: ${props.breakpoint}px)`);
const sheet = computed(() => open.value && !docked.value);
const viewport = useVisualViewport(sheet);
useScrollLock(sheet);

const style = computed(() => (sheet.value && viewport.height ? { top: `${viewport.top}px`, height: `${viewport.height}px`, "--ai-vh": `${viewport.height}px` } : undefined));
const heading = computed(() => (historyOpen.value ? t("history") : props.title || state.title || t("title")));
const mcpError = computed(() => serverErrors(state.mcp));

function reportWidth() {
  const px = open.value && docked.value && root.value ? Math.round(root.value.getBoundingClientRect().width) : 0;
  document.documentElement.style.setProperty("--ai-sidebar-space", `${px}px`);
  emit("width", px);
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  void ai.init();
  observer = new ResizeObserver(reportWidth);
  watch(
    root,
    (el, old) => {
      if (old) observer?.unobserve(old);
      if (el) observer?.observe(el);
      reportWidth();
    },
    { immediate: true },
  );
});
watch([open, docked], () => nextTick(reportWidth));
onBeforeUnmount(() => {
  observer?.disconnect();
  document.documentElement.style.setProperty("--ai-sidebar-space", "0px");
  emit("width", 0);
});

watch(open, (v) => {
  if (v && docked.value) void nextTick(() => composer.value?.focus());
});
watch(
  () => state.focusRequest,
  () => {
    open.value = true;
    historyOpen.value = false;
    void nextTick(() => composer.value?.focus());
  },
);

function newChat() {
  historyOpen.value = false;
  void ai.newChat().then(() => nextTick(() => composer.value?.focus()));
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length && ai.ready) void ai.attachFiles(files);
}

function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files") || !ai.ready) return;
  e.preventDefault();
  dragging.value = true;
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (historyOpen.value) {
    historyOpen.value = false;
    e.preventDefault();
  }
}

function close() {
  open.value = false;
}
</script>

<template>
  <aside
    v-if="open"
    ref="root"
    class="ai-root ai-sidebar"
    :class="{ 'ai-sheet': sheet, 'ai-docked': !sheet, 'ai-keyboard': sheet && viewport.keyboard }"
    :style="style"
    :aria-label="t('title')"
    @dragover="onDragOver"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
    @keydown="onKey"
  >
    <header class="ai-header">
      <button v-if="historyOpen" v-tooltip="t('historyView.back')" type="button" class="ai-icon-btn" @click="historyOpen = false"><ArrowLeft /></button>
      <h2 class="ai-heading ai-truncate">{{ heading }}</h2>
      <AiModelSwitch v-if="!historyOpen && ai.ready" :ai="ai" :boundary="root" />
      <div class="ai-header-actions">
        <button v-tooltip="t('newChat')" type="button" class="ai-icon-btn" :disabled="!state.entries.length && !state.attached.length && !state.draft.trim() && !historyOpen" @click="newChat"><SquarePen /></button>
        <button v-tooltip="t('history')" type="button" class="ai-icon-btn" :aria-pressed="historyOpen" @click="historyOpen = !historyOpen"><History /></button>
        <slot name="header-actions" />
        <button v-if="ai.options.openSettings" v-tooltip="t('settings')" type="button" class="ai-icon-btn ai-hide-narrow" @click="ai.options.openSettings()"><Settings /></button>
        <button v-tooltip="t('close')" type="button" class="ai-icon-btn" @click="close"><X /></button>
      </div>
    </header>
    <div v-if="state.approval === null && mcpError && !state.running && state.error?.kind !== 'tools'" class="ai-notice">{{ t("errors.tools", { message: mcpError }) }}</div>
    <div v-if="state.storageError" class="ai-notice" role="alert">{{ t("errors.storage", { message: state.storageError }) }}</div>
    <AiHistory v-if="historyOpen" :ai="ai" @open="historyOpen = false" />
    <template v-else>
      <AiChatLog :ai="ai">
        <template v-if="$slots.empty" #empty><slot name="empty" /></template>
      </AiChatLog>
      <AiComposer ref="composer" :ai="ai" :boundary="root" :autofocus="docked" @escape="sheet && close()" />
    </template>
    <div v-if="dragging" class="ai-drop">{{ t("dropFiles") }}</div>
  </aside>
  <AiResourcePreview :ai="ai" />
</template>

<style>
.ai-sidebar {
  position: fixed;
  z-index: var(--ai-z);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--vc-bg-subtle);
}
.ai-sidebar.ai-docked {
  top: var(--ai-sidebar-top);
  right: 0;
  bottom: 0;
  width: var(--ai-sidebar-width);
  max-width: 100vw;
  border-left: 1px solid var(--vc-border);
}
.ai-sidebar.ai-sheet {
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  height: 100dvh;
  overscroll-behavior: contain;
  padding-right: env(safe-area-inset-right);
  padding-left: env(safe-area-inset-left);
}
.ai-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: 48px;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--vc-border);
  background: var(--vc-bg);
}
.ai-sheet .ai-header {
  box-sizing: content-box;
  padding-top: env(safe-area-inset-top);
}
.ai-keyboard .ai-header {
  padding-top: 0;
}
.ai-heading {
  flex: 1 1 auto;
  min-width: 40px;
  margin: 0;
  color: var(--vc-fg-strong);
  font-size: 14px;
  font-weight: 600;
}
.ai-header-actions {
  display: flex;
  flex: none;
  align-items: center;
}
.ai-header .ai-icon-btn:first-child {
  margin-left: -6px;
}
.ai-notice {
  flex: none;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vc-border);
  background: var(--vc-warning-soft);
  color: var(--vc-fg-strong);
  font-size: 12px;
}
.ai-sheet .ai-composer {
  padding-bottom: max(10px, env(safe-area-inset-bottom));
}
.ai-sheet.ai-keyboard .ai-composer {
  padding-bottom: 8px;
}
.ai-drop {
  position: absolute;
  inset: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--vc-accent);
  border-radius: var(--vc-radius);
  background: color-mix(in srgb, var(--vc-bg) 88%, transparent);
  color: var(--vc-accent);
  font-weight: 600;
  pointer-events: none;
}
@media (max-width: 420px) {
  .ai-header .ai-hide-narrow {
    display: none;
  }
}
</style>
