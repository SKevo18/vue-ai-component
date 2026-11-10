<script setup lang="ts">
import { Ban, ChevronRight, TriangleAlert } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { Ai } from "../ai";
import type { ToolEntry } from "../core/entries";
import { toolDetail } from "../core/tools";
import { chipIcon } from "../ui/composables";
import { argRows, toolLabel } from "../ui/labels";
import { vTooltip } from "../ui/tooltip";

const props = defineProps<{ entry: ToolEntry; ai: Ai }>();
const open = ref(false);
const t = props.ai.t;

const busy = computed(() => ["pending", "awaiting", "running"].includes(props.entry.status));
const label = computed(() => toolLabel(props.entry.name, t, props.ai.state.toolTitles[props.entry.name]));
const summary = computed(() => (props.entry.status === "rejected" ? t("tool.rejected") : toolDetail(props.entry.args)));
const rows = computed(() => argRows(props.entry.args));
const firstError = computed(() => (props.entry.isError && props.entry.status !== "rejected" ? props.entry.content.split("\n")[0] : ""));
const PREVIEW_CHARS = 120;
const preview = computed(() => {
  if (props.entry.status !== "done" || props.entry.isError || !props.entry.content) return "";
  const flat = props.entry.content.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 3)}...` : flat;
});
const result = computed(() => {
  const text = props.entry.content;
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
});

const urls = ref<string[]>([]);
let created: string[] = [];
watch(
  () => props.entry.images?.map((i) => `${i.uri}#${i.page ?? ""}`).join(",") ?? "",
  async () => {
    const images = props.entry.images ?? [];
    const loaded = await Promise.all(images.map((ref) => props.ai.imageUrl(ref).catch(() => "")));
    for (const u of created) if (u.startsWith("blob:")) URL.revokeObjectURL(u);
    created = loaded;
    urls.value = loaded.filter(Boolean);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  for (const u of created) if (u.startsWith("blob:")) URL.revokeObjectURL(u);
});
</script>

<template>
  <div class="ai-tool" :class="`ai-tool-${entry.status}`">
    <button type="button" class="ai-tool-head" :aria-expanded="open" @click="open = !open">
      <span v-if="busy" class="ai-spinner" aria-hidden="true" />
      <TriangleAlert v-else-if="entry.status === 'error'" class="ai-tool-icon ai-danger-fg" />
      <Ban v-else-if="entry.status === 'rejected'" class="ai-tool-icon ai-warning-fg" />
      <span v-else class="ai-tool-dot" aria-hidden="true" />
      <span class="ai-tool-name">{{ label }}</span>
      <span class="ai-truncate ai-tool-summary">{{ summary }}</span>
      <ChevronRight class="ai-chevron" :class="{ 'ai-open': open }" />
    </button>
    <div v-if="firstError && !open" class="ai-tool-error ai-truncate">{{ firstError }}</div>
    <div v-else-if="preview && !open" class="ai-tool-preview ai-truncate">{{ preview }}</div>
    <div v-if="entry.links?.length || urls.length" class="ai-tool-extra">
      <button v-for="link in entry.links" :key="link.uri" v-tooltip="link.uri" type="button" class="ai-chip" @click="ai.openResource(link.uri)">
        <component :is="chipIcon(undefined, link.uri)" />
        <span class="ai-truncate">{{ link.title || link.name || link.uri }}</span>
      </button>
      <img v-for="(src, i) in urls" :key="i" :src="src" class="ai-tool-image" alt="" loading="lazy" />
    </div>
    <div v-if="open" class="ai-tool-body">
      <div v-if="rows.length" class="ai-tool-section">
        <div class="ai-tool-section-title">{{ t("tool.arguments") }}</div>
        <dl class="ai-args">
          <template v-for="row in rows" :key="row.key">
            <dt>{{ row.key }}</dt>
            <dd :class="{ 'ai-long': row.long }">{{ row.value }}</dd>
          </template>
        </dl>
      </div>
      <div v-if="entry.content" class="ai-tool-section">
        <div class="ai-tool-section-title">{{ t("tool.result") }}</div>
        <pre class="ai-tool-result" :class="{ 'ai-danger-fg': entry.isError }">{{ result }}</pre>
      </div>
    </div>
  </div>
</template>

<style>
.ai-tool {
  overflow: hidden;
  border: 1px solid var(--vc-border);
  border-radius: var(--vc-radius-sm);
  background: var(--vc-bg);
  font-size: 12.5px;
}
.ai-tool-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
}
.ai-tool-head:hover {
  background: var(--vc-bg-subtle);
}
.ai-tool-head .ai-spinner {
  width: 12px;
  height: 12px;
  color: var(--vc-accent);
}
.ai-tool-icon {
  width: 14px;
  height: 14px;
  flex: none;
}
.ai-tool-dot {
  width: 6px;
  height: 6px;
  margin: 0 3px;
  flex: none;
  border-radius: 50%;
  background: var(--vc-success);
}
.ai-tool-name {
  flex: none;
  color: var(--vc-fg-strong);
  font-weight: 550;
}
.ai-tool-summary {
  flex: 1;
  color: var(--vc-fg-muted);
}
.ai-tool-head .ai-chevron {
  color: var(--vc-fg-faint);
}
.ai-danger-fg {
  color: var(--vc-danger);
}
.ai-warning-fg {
  color: var(--vc-warning);
}
.ai-tool-error {
  padding: 3px 8px 5px;
  border-top: 1px solid var(--vc-border);
  color: var(--vc-danger);
}
.ai-tool-preview {
  padding: 0 8px 5px 28px;
  margin-top: -2px;
  color: var(--vc-fg-muted);
  font-size: 12px;
}
.ai-tool-extra {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--vc-border);
}
.ai-tool-image {
  max-width: 160px;
  max-height: 120px;
  border: 1px solid var(--vc-border);
  border-radius: 4px;
  object-fit: contain;
  background: var(--vc-bg-subtle);
  image-rendering: auto;
}
.ai-tool-body {
  padding: 6px 8px 8px;
  border-top: 1px solid var(--vc-border);
  background: var(--vc-bg-subtle);
}
.ai-tool-section + .ai-tool-section {
  margin-top: 8px;
}
.ai-tool-section-title {
  margin-bottom: 3px;
  color: var(--vc-fg-faint);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.ai-args {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0;
}
.ai-args dt {
  color: var(--vc-fg-muted);
  font-family: var(--vc-font-mono);
  font-size: 11.5px;
}
.ai-args dd {
  min-width: 0;
  margin: 0;
  color: var(--vc-fg-strong);
  overflow-wrap: anywhere;
}
.ai-args dd.ai-long {
  grid-column: 1 / -1;
  max-height: 180px;
  overflow: auto;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--vc-bg);
  font-family: var(--vc-font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
}
.ai-tool-result {
  max-height: 240px;
  overflow: auto;
  margin: 0;
  font-family: var(--vc-font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
