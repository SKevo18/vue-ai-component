<script setup lang="ts">
import { Check, CheckCheck, ShieldAlert, ShieldQuestion, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import type { Ai, PendingApproval } from "../ai";
import { approvalDiff } from "../ui/approval-diff";
import { argRows, toolLabel } from "../ui/labels";
import { vTooltip } from "../ui/tooltip";

const props = defineProps<{ approval: PendingApproval; ai: Ai }>();
const t = props.ai.t;
const rows = computed(() => argRows(props.approval.args));
const external = computed(() => props.approval.approval === "confirm");
const label = computed(() => toolLabel(props.approval.tool, t, props.approval.title));
const preview = computed(() => props.approval.preview);
const diff = computed(() => preview.value?.before !== undefined && preview.value.after !== undefined ? approvalDiff(preview.value.before, preview.value.after) : null);
const approveButton = ref<HTMLButtonElement | null>(null);

// typing in a text field must not turn into a decision on the card
onMounted(() => {
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea, select"))) return;
  approveButton.value?.focus({ preventScroll: true });
});
</script>

<template>
  <div class="ai-approval" :class="{ 'ai-external': external }" role="group" :aria-label="external ? t('approval.confirm') : t('approval.ask')">
    <div class="ai-approval-head">
      <component :is="external ? ShieldAlert : ShieldQuestion" class="ai-approval-icon" />
      <span class="ai-approval-question">{{ external ? t("approval.confirm") : t("approval.ask") }}</span>
      <span class="ai-approval-tool ai-truncate">{{ label }}</span>
    </div>
    <div class="ai-approval-preview">
      <p v-if="preview?.categoryHint" class="ai-approval-hint">{{ preview.categoryHint }}</p>
      <p v-if="preview?.summary" class="ai-approval-summary">{{ preview.summary }}</p>
      <p v-if="approval.previewLoading" role="status" class="ai-approval-hint">{{ t("approval.previewLoading") }}</p>
      <p v-if="approval.previewError" role="status" class="ai-approval-hint">{{ t("approval.previewError") }}</p>
      <dl v-if="preview?.fields?.length" class="ai-args ai-approval-fields">
        <template v-for="(field, index) in preview.fields" :key="index">
          <dt>{{ field.label }}</dt>
          <dd class="ai-long">{{ field.value }}</dd>
        </template>
      </dl>
      <div v-if="diff" class="ai-approval-diff">
        <p class="ai-approval-hint">{{ diff.truncated ? t("approval.truncated") : !diff.added && !diff.removed ? t("approval.noChange") : t("approval.summary", { added: diff.added, removed: diff.removed }) }}</p>
        <p v-if="diff.rows.length" class="ai-approval-hint">− {{ t("approval.before") }} / + {{ t("approval.after") }}</p>
        <pre v-if="diff.rows.length" tabindex="0" :aria-label="t('approval.diff')"><template v-for="(row, index) in diff.rows" :key="index"><div v-if="row.type === 'skip'" class="ai-diff-skip">{{ t("approval.skipped", { n: row.count }) }}</div><div v-else :class="`ai-diff-${row.type}`"><span aria-hidden="true">{{ row.type === "add" ? "+ " : row.type === "del" ? "− " : "  " }}</span>{{ row.text }}</div></template></pre>
      </div>
      <details v-if="rows.length && preview" class="ai-approval-raw">
        <summary>{{ t("approval.details") }}</summary>
        <dl class="ai-args ai-approval-args"><template v-for="row in rows" :key="row.key"><dt>{{ row.key }}</dt><dd :class="{ 'ai-long': row.long }">{{ row.value }}</dd></template></dl>
      </details>
      <dl v-else-if="rows.length" class="ai-args ai-approval-args">
        <template v-for="row in rows" :key="row.key"><dt>{{ row.key }}</dt><dd :class="{ 'ai-long': row.long }">{{ row.value }}</dd></template>
      </dl>
    </div>
    <div class="ai-approval-actions">
      <button type="button" class="ai-btn ai-ghost ai-sm" @click="ai.decide('deny')"><X />{{ t("approval.deny") }}</button>
      <button v-if="!external" v-tooltip="t('approval.alwaysHint', { tool: label })" type="button" class="ai-btn ai-sm" @click="ai.decide('always')"><CheckCheck />{{ t("approval.always") }}</button>
      <button ref="approveButton" type="button" class="ai-btn ai-primary ai-sm" @click="ai.decide('approve')"><Check />{{ t("approval.approve") }}</button>
    </div>
  </div>
</template>

<style>
.ai-approval {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--vc-warning) 45%, transparent);
  border-radius: var(--vc-radius-sm);
  background: var(--vc-bg);
  font-size: 12.5px;
}
.ai-approval.ai-external {
  border-color: color-mix(in srgb, var(--vc-danger) 45%, transparent);
}
.ai-approval-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 4px;
  min-width: 0;
}
.ai-approval-icon {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--vc-warning);
}
.ai-external .ai-approval-icon {
  color: var(--vc-danger);
}
.ai-approval-question {
  flex: none;
  color: var(--vc-fg-strong);
  font-weight: 600;
}
.ai-approval-tool {
  color: var(--vc-fg-muted);
}
.ai-approval-args {
  padding: 2px 0;
}
.ai-approval-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--vc-border);
  background: var(--vc-bg-subtle);
}
.ai-approval-preview {
  padding: 4px 10px 8px;
  overflow-wrap: anywhere;
}
.ai-approval-hint {
  margin: 4px 0;
  color: var(--vc-fg-muted);
}
.ai-approval-summary {
  margin: 4px 0;
  white-space: pre-wrap;
}
.ai-approval-diff pre {
  max-height: 18rem;
  overflow: auto;
  margin: 4px 0;
  border: 1px solid var(--vc-border);
  border-radius: var(--vc-radius-sm);
  background: var(--vc-bg-subtle);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ai-approval-diff pre > div {
  padding: 0 6px;
}
.ai-diff-add {
  background: color-mix(in srgb, var(--vc-success, #16834a) 15%, transparent);
}
.ai-diff-del {
  background: color-mix(in srgb, var(--vc-danger) 15%, transparent);
}
.ai-diff-skip {
  color: var(--vc-fg-muted);
}
.ai-approval-raw summary {
  cursor: pointer;
  color: var(--vc-fg-muted);
}
</style>
