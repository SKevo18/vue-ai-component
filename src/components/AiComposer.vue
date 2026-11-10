<script setup lang="ts">
import { ArrowUp, AtSign, Paperclip, ShieldCheck, Square } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ai } from "../ai";
import { PASTE_ATTACHMENT_THRESHOLD } from "../core/attachments";
import type { ResourceRef } from "../core/entries";
import { openSteps } from "../core/plan";
import { useAiInstance } from "../ui/composables";
import { compactNumber, toolList, usageText } from "../ui/labels";
import { vTooltip } from "../ui/tooltip";
import AiChips from "./AiChips.vue";
import AiPlan from "./AiPlan.vue";
import AiResourcePicker from "./AiResourcePicker.vue";
import AiSwitch from "./AiSwitch.vue";

const props = defineProps<{
  ai?: Ai;
  boundary?: HTMLElement | null;
  autofocus?: boolean;
}>();
const emit = defineEmits<{ escape: [] }>();
const ai = useAiInstance(props);
const t = ai.t;
const state = ai.state;

const area = ref<HTMLTextAreaElement | null>(null);
const box = ref<HTMLElement | null>(null);
const files = ref<HTMLInputElement | null>(null);
const picker = ref<InstanceType<typeof AiResourcePicker> | null>(null);
const pickerOpen = ref(false);
const query = ref("");
let mention: number | null = null;
let inserted = false;

const plan = computed(() => (ai.plan && openSteps(ai.plan).length ? ai.plan : null));
const canSend = computed(() => ai.ready && !state.running && !!state.draft.trim() && !state.adding.length);
const chatAuto = computed({ get: () => state.chatAutoApprove || state.preferences.autoApproveWrites, set: (v: boolean) => ai.setChatAutoApprove(v) });
const allowedTools = computed(() => (state.allowedTools.length ? toolList(state.allowedTools, t, ai.locale(), state.toolTitles) : ""));
const tokenUsage = computed(() => state.entries.reduce((total, entry) => {
  if (entry.role === "assistant" && entry.usage) {
    total.input += entry.usage.input;
    total.output += entry.usage.output;
    total.cached += entry.usage.cached ?? 0;
  }
  return total;
}, { input: 0, output: 0, cached: 0 }));
const tokenTotal = computed(() => tokenUsage.value.input + tokenUsage.value.output);
const pasteNotice = ref(false);
let pasteTimer: ReturnType<typeof setTimeout> | undefined;
function flush() {
  void ai.flush();
}
onBeforeUnmount(() => {
  clearTimeout(pasteTimer);
  window.removeEventListener("pagehide", flush);
  flush();
});

function resize() {
  const el = area.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

function detectMention() {
  const el = area.value;
  if (!el) return;
  const before = el.value.slice(0, el.selectionStart);
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  const uri = /(?:^|\s)([a-z][a-z0-9+.-]*:\/\/\S*)$/i.exec(before);
  if (at) {
    mention = before.length - at[1]!.length - 1;
    query.value = at[1]!;
    pickerOpen.value = true;
  } else if (uri && !/^https?:/i.test(uri[1]!)) {
    mention = before.length - uri[1]!.length;
    query.value = uri[1]!;
    pickerOpen.value = true;
  } else if (mention !== null) {
    pickerOpen.value = false;
    mention = null;
  }
}

function onInput() {
  resize();
  detectMention();
}

function pick(ref: ResourceRef) {
  const el = area.value;
  if (el && mention !== null) {
    const end = el.selectionStart;
    const tail = state.draft.slice(end);
    const replacement = ref.uri + (tail && /^\s/.test(tail) ? "" : " ");
    state.draft = state.draft.slice(0, mention) + replacement + tail;
    const caret = mention + replacement.length;
    void nextTick(() => {
      el.setSelectionRange(caret, caret);
      resize();
    });
  }
  mention = null;
  ai.attach(ref);
  el?.focus();
}

function openPicker() {
  const el = area.value;
  if (!el) return;
  if (pickerOpen.value) {
    pickerOpen.value = false;
    el.focus();
    return;
  }
  const start = el.selectionStart;
  const before = state.draft.slice(0, start);
  const insert = before && !/\s$/.test(before) ? " @" : "@";
  state.draft = before + insert + state.draft.slice(el.selectionEnd);
  const caret = start + insert.length;
  inserted = true;
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
    detectMention();
  });
}

watch(pickerOpen, (open) => {
  if (open || !inserted) return;
  inserted = false;
  if (mention === null || state.draft[mention] !== "@") return;
  const at = mention;
  mention = null;
  state.draft = state.draft.slice(0, at) + state.draft.slice(at + 1 + query.value.length);
  void nextTick(() => area.value?.setSelectionRange(at, at));
});

function send() {
  if (!canSend.value) return;
  inserted = false;
  mention = null;
  pickerOpen.value = false;
  void ai.send();
}

function focusEnd() {
  const el = area.value;
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}
watch(
  () => state.focusRequest,
  () => nextTick(focusEnd),
);

function onKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (picker.value?.key(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === "Escape") {
    if (state.running) {
      e.preventDefault();
      ai.stop();
    } else if (!state.draft) emit("escape");
  }
}

function onPaste(e: ClipboardEvent) {
  const list = [...(e.clipboardData?.files ?? [])];
  if (list.length) {
    e.preventDefault();
    void ai.attachFiles(list);
    return;
  }
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (text.length > PASTE_ATTACHMENT_THRESHOLD) {
    e.preventDefault();
    const el = area.value;
    const start = el?.selectionStart ?? state.draft.length;
    const end = el?.selectionEnd ?? start;
    const original = state.draft;
    void ai.attachText(text, "pasted-text.txt").then((ref) => {
      if (!ref) return;
      const at = state.draft === original ? start : el?.selectionStart ?? state.draft.length;
      const to = state.draft === original ? end : el?.selectionEnd ?? at;
      const before = state.draft.slice(0, at);
      const after = state.draft.slice(to);
      const reference = (before && !/\s$/.test(before) ? " " : "") + ref.uri + (after && /^\s/.test(after) ? "" : " ");
      state.draft = before + reference + after;
      pasteNotice.value = true;
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => { pasteNotice.value = false; }, 5000);
      void nextTick(() => {
        el?.setSelectionRange(at + reference.length, at + reference.length);
        resize();
      });
    });
  }
}

function onFiles() {
  const list = [...(files.value?.files ?? [])];
  if (files.value) files.value.value = "";
  if (list.length) void ai.attachFiles(list);
}

function onDrop(e: DragEvent) {
  const list = [...(e.dataTransfer?.files ?? [])];
  if (!list.length) return;
  e.preventDefault();
  e.stopPropagation();
  void ai.attachFiles(list);
}

watch(() => state.draft, () => nextTick(resize));
onMounted(() => {
  resize();
  window.addEventListener("pagehide", flush);
  if (props.autofocus) area.value?.focus({ preventScroll: true });
});

defineExpose({ focus: focusEnd, openPicker });
</script>

<template>
  <form class="ai-composer" @submit.prevent="send" @dragover.prevent @drop="onDrop">
    <div v-if="allowedTools" class="ai-allowed" role="note">
      <ShieldCheck class="ai-allowed-icon" />
      <span class="ai-allowed-text">{{ t("allowedTools", { tools: allowedTools }) }}</span>
      <button type="button" class="ai-btn ai-ghost ai-sm" @click="ai.resetAllowedTools()">{{ t("resetAllowedTools") }}</button>
    </div>
    <div v-if="plan || ai.chips.length || state.adding.length || state.attachError || pasteNotice" class="ai-composer-top">
      <AiPlan v-if="plan" :plan="plan" :t="t" />
      <div v-if="ai.chips.length || state.adding.length" class="ai-chips">
        <AiChips :items="ai.chips" :t="t" removable @open="(c) => ai.openResource(c.uri)" @remove="(c) => ai.detach(c.uri)" />
        <span v-for="(name, i) in state.adding" :key="`adding-${i}`" class="ai-chip ai-chip-adding">
          <span class="ai-spinner" />
          <span class="ai-truncate">{{ t("attachments.adding", { name }) }}</span>
        </span>
      </div>
      <div v-if="state.attachError" class="ai-attach-error">{{ state.attachError }}</div>
      <div v-if="pasteNotice" class="ai-paste-notice" role="status">{{ t("pastedNotice") }}</div>
    </div>
    <div ref="box" class="ai-input-box" @click.self="area?.focus()">
      <textarea
        ref="area"
        v-model="state.draft"
        rows="1"
        class="ai-textarea"
        :placeholder="ai.ready ? t('placeholder') : t('placeholderOff')"
        :aria-label="t('placeholder')"
        :disabled="!ai.ready"
        enterkeyhint="send"
        @input="onInput"
        @click="detectMention"
        @keydown="onKey"
        @paste="onPaste"
      />
      <div class="ai-input-row">
        <button v-tooltip="t('attach')" type="button" class="ai-icon-btn ai-sm" :disabled="!ai.ready" @click="files?.click()"><Paperclip /></button>
        <button v-tooltip="t('mention')" type="button" class="ai-icon-btn ai-sm" :aria-pressed="pickerOpen" :disabled="!ai.ready" @click="openPicker"><AtSign /></button>
        <span v-if="tokenTotal" v-tooltip="usageText(tokenUsage, t, ai.locale())" class="ai-token-total">{{ t("tokenTotal", { count: compactNumber(tokenTotal, ai.locale()) }) }}</span>
        <span class="ai-spacer" />
        <AiSwitch v-model="chatAuto" v-tooltip="t('autoApproveHint')" class="ai-auto" :disabled="state.preferences.autoApproveWrites">
          <span class="ai-truncate">{{ t("autoApprove") }}</span>
        </AiSwitch>
        <button v-if="state.running" v-tooltip="{ text: t('stop'), keys: 'Esc' }" type="button" class="ai-send ai-stop" @click="ai.stop()"><Square /></button>
        <button v-else v-tooltip="{ text: t('sendHint'), keys: 'Enter' }" :aria-label="t('send')" type="submit" class="ai-send" :disabled="!canSend"><ArrowUp /></button>
      </div>
    </div>
    <input ref="files" type="file" multiple hidden @change="onFiles" />
    <AiResourcePicker ref="picker" v-model:open="pickerOpen" :ai="ai" :anchor="box" :boundary="boundary" :query="query" @pick="pick" />
  </form>
</template>

<style>
.ai-composer {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  max-height: 60%;
  padding: 6px 10px 10px;
}
.ai-composer-top {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ai-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ai-chips .ai-chip {
  max-width: 220px;
}
.ai-chip-adding {
  padding-right: 8px;
  color: var(--vc-fg-muted);
}
.ai-chip-adding .ai-spinner {
  width: 11px;
  height: 11px;
}
.ai-attach-error {
  color: var(--vc-danger);
  font-size: 12px;
}
.ai-paste-notice,
.ai-token-total {
  color: var(--vc-fg-faint);
  font-size: 11px;
}
.ai-token-total {
  white-space: nowrap;
  margin-left: 4px;
}
.ai-allowed {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 8px;
  border-radius: var(--vc-radius-sm);
  background: var(--vc-warning-soft);
  color: var(--vc-fg-strong);
  font-size: 12px;
}
.ai-allowed-icon {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--vc-warning);
}
.ai-allowed-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ai-allowed .ai-btn {
  flex: none;
}
.ai-input-box {
  display: flex;
  flex: none;
  flex-direction: column;
  border: 1px solid var(--vc-border-strong);
  border-radius: var(--vc-radius);
  background: var(--vc-bg);
  cursor: text;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.ai-input-box:focus-within {
  border-color: var(--vc-accent);
  box-shadow: var(--vc-ring);
}
.ai-textarea {
  display: block;
  width: 100%;
  min-height: 38px;
  max-height: min(200px, calc(var(--ai-vh, 100vh) * 0.3));
  padding: 9px 11px 2px;
  border: 0;
  background: transparent;
  color: var(--vc-fg-strong);
  font: inherit;
  font-size: 13.5px;
  line-height: 1.45;
  resize: none;
  outline: none;
  overflow-y: auto;
}
.ai-textarea::placeholder {
  color: var(--vc-fg-faint);
}
.ai-input-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 2px 5px 5px;
  cursor: default;
}
.ai-spacer {
  flex: 1;
}
.ai-auto {
  flex: 0 1 auto;
  margin-right: 6px;
  color: var(--vc-fg-muted);
  font-size: 12px;
}
.ai-auto .ai-switch-label {
  min-width: 0;
  overflow: hidden;
}
.ai-send {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: var(--vc-accent);
  color: var(--vc-accent-fg);
  cursor: pointer;
}
.ai-send:disabled {
  background: var(--vc-bg-muted);
  color: var(--vc-fg-faint);
  cursor: default;
}
.ai-send svg {
  width: 16px;
  height: 16px;
}
.ai-stop {
  background: var(--vc-bg-active);
  color: var(--vc-fg-strong);
}
.ai-stop svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}
@media (pointer: coarse), (hover: none) {
  .ai-textarea {
    font-size: 16px;
  }
  .ai-send {
    width: 36px;
    height: 36px;
  }
}
</style>
