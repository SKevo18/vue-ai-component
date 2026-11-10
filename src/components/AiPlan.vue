<script setup lang="ts">
import { ChevronRight, Circle, CircleCheck, CircleDot, CircleSlash } from "@lucide/vue";
import { computed, ref } from "vue";
import type { PlanStep } from "../core/plan";
import type { Translate } from "../i18n";

const props = defineProps<{ plan: PlanStep[]; t: Translate }>();
const open = ref(true);
const done = computed(() => props.plan.filter((s) => s.status === "done").length);
const active = computed(() => props.plan.find((s) => s.status === "active"));
const icons = { pending: Circle, active: CircleDot, done: CircleCheck, dropped: CircleSlash };
</script>

<template>
  <div class="ai-plan">
    <button type="button" class="ai-plan-head" :aria-expanded="open" @click="open = !open">
      <ChevronRight class="ai-chevron" :class="{ 'ai-open': open }" />
      <span class="ai-plan-title">{{ t("plan.title") }}</span>
      <span class="ai-plan-progress">{{ t("plan.progress", { done, total: plan.length }) }}</span>
      <span v-if="!open && active" class="ai-truncate ai-plan-active">{{ active.text }}</span>
    </button>
    <ol v-if="open" class="ai-plan-steps">
      <li v-for="(s, i) in plan" :key="i" :class="`ai-step-${s.status}`">
        <component :is="icons[s.status]" class="ai-step-icon" />
        <span>{{ s.text }}</span>
      </li>
    </ol>
  </div>
</template>

<style>
.ai-plan {
  font-size: 12.5px;
}
.ai-plan-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--vc-fg-muted);
  text-align: left;
  cursor: pointer;
}
.ai-plan-title {
  color: var(--vc-fg-strong);
  font-weight: 600;
}
.ai-plan-active {
  flex: 1;
}
.ai-plan-steps {
  margin: 2px 0 0;
  padding: 0 0 0 4px;
  list-style: none;
}
.ai-plan-steps li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 1px 0;
}
.ai-step-icon {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 2px;
  color: var(--vc-fg-faint);
}
.ai-step-active {
  color: var(--vc-fg-strong);
  font-weight: 550;
}
.ai-step-active .ai-step-icon {
  color: var(--vc-accent);
}
.ai-step-done {
  color: var(--vc-fg-muted);
}
.ai-step-done .ai-step-icon {
  color: var(--vc-success);
}
.ai-step-dropped {
  color: var(--vc-fg-faint);
  text-decoration: line-through;
}
</style>
