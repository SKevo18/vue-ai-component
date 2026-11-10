<script setup lang="ts">
import { ChevronRight } from "@lucide/vue";
import { computed, ref } from "vue";
import type { Ai } from "../ai";
import type { Translate } from "../i18n";
import AiMarkdown from "./AiMarkdown.vue";

const props = defineProps<{ text: string; streaming?: boolean; t: Translate; ai?: Ai }>();
const open = ref(false);
const lastLine = computed(() =>
  (props.text.trim().split("\n").filter(Boolean).pop() ?? "")
    .replace(/[*#`]+/g, "")
    .trim(),
);
</script>

<template>
  <div class="ai-reasoning">
    <button type="button" class="ai-reasoning-head" :aria-expanded="open" @click="open = !open">
      <ChevronRight class="ai-chevron" :class="{ 'ai-open': open }" />
      <span>{{ streaming ? t("reasoning.live") : t("reasoning.done") }}</span>
      <span v-if="streaming && !open" class="ai-truncate ai-reasoning-tail">{{ lastLine }}</span>
    </button>
    <AiMarkdown v-if="open" class="ai-reasoning-body" :source="text.trim()" :streaming="streaming" :ai="ai" />
  </div>
</template>

<style>
.ai-reasoning {
  margin-bottom: 4px;
  font-size: 12.5px;
}
.ai-reasoning-head {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 4px 2px 0;
  border: 0;
  background: none;
  color: var(--vc-fg-muted);
  cursor: pointer;
}
.ai-reasoning-head:hover {
  color: var(--vc-fg-strong);
}
.ai-reasoning-tail {
  color: var(--vc-fg-faint);
}
.ai-chevron {
  width: 14px;
  height: 14px;
  flex: none;
  transition: transform 0.15s;
}
.ai-chevron.ai-open {
  transform: rotate(90deg);
}
.ai-reasoning-body {
  max-height: 240px;
  overflow-y: auto;
  margin: 2px 0 6px 6px;
  padding-left: 10px;
  border-left: 2px solid var(--vc-border);
}
.ai-md.ai-reasoning-body {
  color: var(--vc-fg-muted);
}
</style>
