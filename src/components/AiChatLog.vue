<script setup lang="ts">
import { AlertCircle, RotateCcw, Settings, Sparkles, X } from "@lucide/vue";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { Ai, Suggestion } from "../ai";
import type { Entry } from "../core/entries";
import { useAiInstance, useElapsed } from "../ui/composables";
import { toolLabel, usageText } from "../ui/labels";
import { vTooltip } from "../ui/tooltip";
import AiApproval from "./AiApproval.vue";
import AiChips from "./AiChips.vue";
import AiMarkdown from "./AiMarkdown.vue";
import AiReasoning from "./AiReasoning.vue";
import AiToolCard from "./AiToolCard.vue";

const props = defineProps<{ ai?: Ai }>();
const ai = useAiInstance(props);
const t = ai.t;
const state = ai.state;
const log = ref<HTMLElement | null>(null);
let stick = true;

const elapsed = useElapsed(
  () => state.running,
  () => state.runStartedAt,
);

const activityText = computed(() => {
  const a = state.activity;
  if (!a.kind) return "";
  const text =
    a.kind === "tool"
      ? `${toolLabel(a.tool ?? "", t, state.toolTitles[a.tool ?? ""])}${a.detail ? `: ${a.detail}` : ""}`
      : a.kind === "retry"
        ? t("activity.retry", { detail: a.detail ?? "" })
        : t(`activity.${a.kind}`);
  const s = elapsed();
  return s < 2 ? text : `${text} ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`;
});

const streamingVisible = computed(() => {
  const last = state.entries[state.entries.length - 1];
  return last?.role === "assistant" && last.streaming && !!last.content;
});

function visible(e: Entry): boolean {
  return e.role !== "assistant" || !!e.content || !!e.reasoning;
}

const HEADLINES = new Set(["auth", "rate_limit", "network", "server", "bad_request", "unknown"]);
const errorHeadline = computed(() => (state.error && HEADLINES.has(state.error.kind) ? t(`errors.${state.error.kind}`) : ""));

function suggest(s: Suggestion) {
  for (const r of s.resources ?? []) ai.attach(r);
  void ai.send(s.prompt);
}

function onScroll() {
  const el = log.value;
  if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToEnd(force = false) {
  if (!stick && !force) return;
  void nextTick(() => {
    const el = log.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(
  () => {
    const last = state.entries[state.entries.length - 1];
    return [state.entries.length, last?.role === "assistant" ? last.content.length + (last.reasoning?.length ?? 0) : last?.role === "tool" ? last.status : 0, state.approval, state.activity.kind, state.error];
  },
  () => scrollToEnd(),
);
watch(
  () => [state.conversationId, state.connectionsLoaded],
  () => {
    stick = true;
    scrollToEnd(true);
  },
);
onMounted(() => scrollToEnd(true));

defineExpose({ scrollToEnd: () => scrollToEnd(true) });
</script>

<template>
  <div ref="log" class="ai-log" role="log" aria-live="polite" @scroll.passive="onScroll">
    <div v-if="!state.connectionsLoaded" class="ai-log-center"><span class="ai-spinner" /></div>
    <div v-else-if="!ai.ready && !state.entries.length" class="ai-log-center ai-empty">
      <div class="ai-empty-mark"><Sparkles /></div>
      <p>{{ state.connectionsError || t("notConnected") }}</p>
      <button v-if="ai.options.openSettings" type="button" class="ai-btn ai-primary ai-sm" @click="ai.options.openSettings()"><Settings />{{ t("connect") }}</button>
    </div>
    <div v-else-if="!state.entries.length && !state.running" class="ai-log-center ai-empty">
      <slot name="empty">
        <div class="ai-empty-mark"><Sparkles /></div>
        <p>{{ t("empty") }}</p>
        <div v-if="ai.suggestions.length" class="ai-suggestions">
          <button v-for="s in ai.suggestions" :key="s.label" type="button" class="ai-suggestion" @click="suggest(s)">{{ s.label }}</button>
        </div>
      </slot>
    </div>
    <ol v-else class="ai-entries">
      <template v-for="e in state.entries" :key="e.id">
        <li v-if="e.role === 'user'" class="ai-user">
          <div class="ai-bubble">{{ e.content }}</div>
          <div v-if="e.resources?.length" class="ai-user-chips">
            <AiChips :items="e.resources" :t="t" @open="(r) => ai.openResource(r.uri)" />
          </div>
        </li>
        <li v-else-if="e.role === 'assistant' && visible(e)" class="ai-assistant">
          <AiReasoning v-if="e.reasoning" :text="e.reasoning" :streaming="e.streaming && !e.content" :t="t" :ai="ai" />
          <AiMarkdown v-if="e.content" :source="e.content" :streaming="e.streaming" :ai="ai" />
          <div v-if="e.usage && !e.streaming && e.content" class="ai-usage" :title="t('usageHint')">{{ usageText(e.usage, t, ai.locale()) }}</div>
        </li>
        <li v-else-if="e.role === 'reminder'" class="ai-reminder">{{ t("reminder") }}</li>
        <li v-else-if="e.role === 'tool' && state.approval && e.status === 'awaiting' && state.approval.toolCallId === e.toolCallId">
          <AiApproval :approval="state.approval" :ai="ai" />
        </li>
        <li v-else-if="e.role === 'tool'"><AiToolCard :entry="e" :ai="ai" /></li>
      </template>
    </ol>
    <div v-if="state.running && state.activity.kind && !streamingVisible && !state.approval" class="ai-activity" role="status">
      <span class="ai-pulse" aria-hidden="true" />
      <span class="ai-truncate">{{ activityText }}</span>
    </div>
    <div v-if="state.error" class="ai-error" role="alert">
      <AlertCircle class="ai-error-icon" />
      <span v-if="state.error.failures?.length" class="ai-error-text"><span v-for="f in state.error.failures" :key="f.id" v-tooltip="f.error" class="ai-failure" tabindex="0">{{ t("errors.tools", { name: f.name }) }}</span></span>
      <span v-else class="ai-error-text"><strong v-if="errorHeadline" class="ai-error-headline">{{ errorHeadline }}</strong> {{ state.error.message }}</span>
      <button v-if="state.error.kind === 'auth' && ai.options.openSettings" v-tooltip="t('settings')" type="button" class="ai-icon-btn ai-sm" @click="ai.options.openSettings()"><Settings /></button>
      <button v-if="!state.running && state.error.kind !== 'tools' && state.entries.length" v-tooltip="t('retry')" type="button" class="ai-icon-btn ai-sm" @click="ai.retry()"><RotateCcw /></button>
      <button v-tooltip="t('dismiss')" type="button" class="ai-icon-btn ai-sm" @click="ai.dismissError()"><X /></button>
    </div>
  </div>
</template>

<style>
.ai-log {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 12px 8px;
  -webkit-overflow-scrolling: touch;
}
.ai-log-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 100%;
  padding: 16px;
  text-align: center;
}
.ai-empty p {
  margin: 0;
  color: var(--vc-fg-muted);
}
.ai-empty-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--vc-accent-soft);
  color: var(--vc-accent);
}
.ai-empty-mark svg {
  width: 22px;
  height: 22px;
}
.ai-suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  max-width: 340px;
}
.ai-suggestion {
  padding: 4px 12px;
  border: 1px solid var(--vc-border-strong);
  border-radius: 999px;
  background: var(--vc-bg);
  color: var(--vc-fg);
  font-size: 12.5px;
  cursor: pointer;
}
.ai-suggestion:hover {
  border-color: var(--vc-accent);
  color: var(--vc-accent);
}
.ai-entries {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ai-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  padding-left: 32px;
}
.ai-bubble {
  max-width: 100%;
  padding: 7px 11px;
  border-radius: 14px 14px 4px 14px;
  background: var(--ai-bubble-bg);
  color: var(--ai-bubble-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ai-user-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  max-width: 100%;
}
.ai-user-chips .ai-chip {
  padding-right: 7px;
}
.ai-assistant {
  padding-right: 8px;
}
.ai-usage {
  margin-top: 4px;
  color: var(--vc-fg-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ai-reminder {
  color: var(--vc-fg-faint);
  font-size: 12px;
  font-style: italic;
}
.ai-error-headline {
  font-weight: 650;
}
.ai-activity {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  color: var(--vc-fg-muted);
  font-size: 12px;
}
.ai-pulse {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--vc-accent);
  animation: ai-pulse 1.2s ease-in-out infinite;
}
@keyframes ai-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}
.ai-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 7px 8px 7px 10px;
  border-radius: var(--vc-radius-sm);
  background: var(--vc-danger-soft);
  color: var(--vc-fg-strong);
  font-size: 12.5px;
}
.ai-error-icon {
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 1px;
  color: var(--vc-danger);
}
.ai-error-text {
  flex: 1;
  min-width: 0;
  padding-top: 1px;
  overflow-wrap: anywhere;
}
.ai-error .ai-icon-btn {
  margin: -3px 0;
}
</style>
