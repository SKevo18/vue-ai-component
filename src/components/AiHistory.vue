<script setup lang="ts">
import { Check, FileDown, Pencil, Search, Trash2, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ai } from "../ai";
import type { ConversationMeta } from "../stores/conversations";
import { useAiInstance } from "../ui/composables";
import { vTooltip } from "../ui/tooltip";

const props = defineProps<{ ai?: Ai }>();
const emit = defineEmits<{ open: [id: string] }>();
const ai = useAiInstance(props);
const t = ai.t;
const state = ai.state;

const query = ref("");
const editing = ref<string | null>(null);
const editTitle = ref("");
const confirming = ref<string | null>(null);
const editInput = ref<HTMLInputElement[]>([]);

const bodies = new Map<string, string>();
const found = ref<ConversationMeta[] | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let searchId = 0;

watch([query, () => state.history], ([q]) => {
  clearTimeout(timer);
  found.value = null;
  const id = ++searchId;
  if (q.trim().length < 2) return;
  timer = setTimeout(async () => {
    const result = await ai.searchHistory(q, bodies);
    if (id === searchId) found.value = result;
  }, 200);
});
onBeforeUnmount(() => clearTimeout(timer));

const items = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return state.history;
  return found.value ?? state.history.filter((h) => h.title.toLowerCase().includes(q));
});

const format = (ms: number) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(ai.locale(), { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(ai.locale(), { day: "numeric", month: "short" });
};

async function open(id: string) {
  await ai.openChat(id);
  emit("open", id);
}

function rename(id: string, title: string) {
  editing.value = id;
  editTitle.value = title;
  void nextTick(() => editInput.value[0]?.select());
}

async function saveRename() {
  const id = editing.value;
  editing.value = null;
  if (id && editTitle.value.trim()) await ai.renameChat(id, editTitle.value);
}

async function remove(id: string) {
  confirming.value = null;
  await ai.removeChat(id);
}

const confirmingAll = ref(false);
const exportError = ref("");

async function removeAll() {
  confirmingAll.value = false;
  await ai.removeAllChats();
}

async function download(id: string) {
  exportError.value = "";
  try {
    const { filename, json } = await ai.exportConversation(id);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    exportError.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(() => void ai.loadHistory());
</script>

<template>
  <div class="ai-history">
    <label class="ai-history-search">
      <Search />
      <input v-model="query" class="ai-history-input" type="search" :placeholder="t('historyView.search')" :aria-label="t('historyView.search')" />
    </label>
    <ul v-if="items.length" class="ai-history-list">
      <li v-for="h in items" :key="h.id" class="ai-history-item" :class="{ 'ai-current': h.id === state.conversationId }">
        <template v-if="editing === h.id">
          <input ref="editInput" v-model="editTitle" class="ai-input" :aria-label="t('historyView.rename')" @keydown.enter.prevent="saveRename" @keydown.esc.stop="editing = null" />
          <button v-tooltip="t('historyView.rename')" type="button" class="ai-icon-btn ai-sm" @click="saveRename"><Check /></button>
        </template>
        <template v-else-if="confirming === h.id">
          <span class="ai-history-title ai-truncate">{{ t("historyView.deleteConfirm") }}</span>
          <button type="button" class="ai-btn ai-sm ai-danger" @click="remove(h.id)"><Trash2 />{{ t("historyView.delete") }}</button>
          <button v-tooltip="t('connections.cancel')" type="button" class="ai-icon-btn ai-sm" @click="confirming = null"><X /></button>
        </template>
        <template v-else>
          <button type="button" class="ai-history-open" @click="open(h.id)">
            <span class="ai-history-title ai-truncate">{{ h.title || t("historyView.untitled") }}</span>
            <span class="ai-history-date">{{ h.id === state.conversationId ? t("historyView.current") : format(h.updatedAt) }}</span>
          </button>
          <button v-tooltip="t('historyView.export')" type="button" class="ai-icon-btn ai-sm ai-history-action" @click="download(h.id)"><FileDown /></button>
          <button v-tooltip="t('historyView.rename')" type="button" class="ai-icon-btn ai-sm ai-history-action" @click="rename(h.id, h.title)"><Pencil /></button>
          <button v-tooltip="t('historyView.delete')" type="button" class="ai-icon-btn ai-sm ai-history-action" @click="confirming = h.id"><Trash2 /></button>
        </template>
      </li>
    </ul>
    <p v-else class="ai-history-empty">{{ state.history.length ? t("historyView.noMatch") : t("historyView.empty") }}</p>
    <p v-if="exportError" class="ai-history-error">{{ exportError }}</p>
    <div v-if="state.history.length" class="ai-history-footer">
      <template v-if="confirmingAll">
        <span class="ai-truncate">{{ t("historyView.deleteAllConfirm") }}</span>
        <button type="button" class="ai-btn ai-sm ai-danger" @click="removeAll"><Trash2 />{{ t("historyView.deleteAll") }}</button>
        <button v-tooltip="t('connections.cancel')" type="button" class="ai-icon-btn ai-sm" @click="confirmingAll = false"><X /></button>
      </template>
      <button v-else type="button" class="ai-btn ai-ghost ai-sm ai-danger" @click="confirmingAll = true"><Trash2 />{{ t("historyView.deleteAll") }}</button>
    </div>
  </div>
</template>

<style>
.ai-history {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}
.ai-history-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--vc-border);
  color: var(--vc-fg-faint);
}
.ai-history-search svg {
  width: 15px;
  height: 15px;
  flex: none;
}
.ai-history-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--vc-fg-strong);
  font: inherit;
  outline: none;
}
.ai-history-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 4px;
  list-style: none;
}
.ai-history-item {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 40px;
  padding: 0 4px;
  border-radius: var(--vc-radius-sm);
}
.ai-history-item:hover,
.ai-history-item.ai-current {
  background: var(--vc-bg-muted);
}
.ai-history-open {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 40px;
  padding: 0 6px;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
}
.ai-history-title {
  flex: 1;
  color: var(--vc-fg-strong);
}
.ai-history-date {
  flex: none;
  color: var(--vc-fg-faint);
  font-size: 12px;
}
.ai-history-action {
  opacity: 0;
}
.ai-history-item:hover .ai-history-action,
.ai-history-action:focus-visible {
  opacity: 1;
}
@media (hover: none) {
  .ai-history-action {
    opacity: 1;
  }
}
.ai-history-footer {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  padding: 6px 8px;
  border-top: 1px solid var(--vc-border);
  color: var(--vc-fg-muted);
  font-size: 12.5px;
}
.ai-history-footer > .ai-truncate {
  flex: 1;
}
.ai-history-error {
  margin: 0;
  padding: 6px 12px;
  color: var(--vc-danger);
  font-size: 12.5px;
}
.ai-history-empty {
  margin: 0;
  padding: 32px 16px;
  color: var(--vc-fg-muted);
  text-align: center;
}
</style>
