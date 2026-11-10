<script setup lang="ts">
import { ChevronLeft, ChevronRight, Download, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Ai } from "../ai";
import type { ReadResult } from "../core/namespaces";
import { errorText } from "../core/types";
import { useAiInstance } from "../ui/composables";

const props = defineProps<{ ai?: Ai }>();
const ai = useAiInstance(props);
const t = ai.t;
const dialog = ref<HTMLDialogElement | null>(null);
const content = ref<ReadResult | null>(null);
const loading = ref(false);
const error = ref("");
const image = ref("");
const original = ref("");
const offsets = ref<number[]>([]);
const page = ref(1);
const title = computed(() => content.value?.name || ai.state.preview?.original?.name || ai.state.preview?.uri || t("preview.title"));
let controller: AbortController | null = null;
let request = 0;
let focusBefore: HTMLElement | null = null;

function revoke(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function cancel() {
  request++;
  controller?.abort();
  controller = null;
  revoke(image.value);
  image.value = "";
}

async function load(nextPage = 1, offset = 0) {
  const uri = ai.state.preview?.uri;
  if (!uri) return;
  cancel();
  const current = request;
  const abort = new AbortController();
  controller = abort;
  loading.value = true;
  error.value = "";
  content.value = null;
  page.value = nextPage;
  try {
    const result = await ai.read(uri, { page: nextPage, offset, signal: abort.signal });
    if (current !== request || abort.signal.aborted) return;
    content.value = result;
    if (result.image) {
      const source = await ai.imageUrl(result.image);
      if (current !== request || abort.signal.aborted) {
        revoke(source);
        return;
      }
      // never render namespace-provided markup or accept executable URL schemes as an image source
      if (!source.startsWith("blob:") && !/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(source)) {
        revoke(source);
        throw new Error(t("preview.imageError"));
      }
      image.value = source;
    }
  } catch (e) {
    if (current === request && !abort.signal.aborted) error.value = errorText(e);
  } finally {
    if (current === request) loading.value = false;
  }
}

function nextChunk() {
  if (content.value?.nextOffset === undefined) return;
  offsets.value.push(content.value.offset);
  void load(page.value, content.value.nextOffset);
}

function previousChunk() {
  const offset = offsets.value.pop();
  if (offset !== undefined) void load(page.value, offset);
}

function changePage(value: number) {
  offsets.value = [];
  void load(value);
}

function close() {
  ai.closePreview();
}

watch(() => ai.state.preview, async (preview) => {
  cancel();
  content.value = null;
  offsets.value = [];
  page.value = 1;
  error.value = "";
  if (!preview) {
    dialog.value?.close();
    if (focusBefore?.isConnected) focusBefore.focus();
    focusBefore = null;
    return;
  }
  const current = request;
  if (!dialog.value?.open) focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (current !== request) return;
  if (dialog.value && !dialog.value.open) dialog.value.showModal();
  void load();
}, { immediate: true });

watch(() => ai.state.preview?.original, (file) => {
  revoke(original.value);
  original.value = file ? URL.createObjectURL(file.blob) : "";
}, { immediate: true });

onBeforeUnmount(() => {
  cancel();
  revoke(original.value);
  ai.closePreview();
});
</script>

<template>
  <dialog v-if="ai.state.preview" ref="dialog" class="ai-root ai-resource-preview" :aria-label="t('preview.title')" @cancel.prevent="close">
    <header class="ai-preview-header">
      <h2 class="ai-truncate">{{ title }}</h2>
      <a v-if="original" class="ai-btn" :href="original" :download="ai.state.preview.original?.name"><Download />{{ t("preview.download") }}</a>
      <button type="button" class="ai-icon-btn" :aria-label="t('close')" autofocus @click="close"><X /></button>
    </header>
    <div class="ai-preview-body" :aria-busy="loading">
      <p v-if="loading" role="status">{{ t("preview.loading") }}</p>
      <p v-if="error" role="alert" class="ai-preview-error">{{ t("preview.error") }} {{ error }}</p>
      <img v-if="image" :src="image" :alt="title" @error="error = t('preview.imageError')" />
      <pre v-if="content?.text !== undefined">{{ content.text }}</pre>
      <p v-if="!loading && !error && content && !image && content.text === undefined">{{ t("preview.empty") }}</p>
    </div>
    <footer v-if="content && ((content.pages ?? 1) > 1 || offsets.length || content.nextOffset !== undefined)" class="ai-preview-footer">
      <nav v-if="(content.pages ?? 1) > 1" :aria-label="t('preview.pages')">
        <button type="button" class="ai-icon-btn" :aria-label="t('preview.previousPage')" :disabled="loading || page <= 1" @click="changePage(page - 1)"><ChevronLeft /></button>
        <span>{{ t("preview.page", { page, pages: content.pages ?? 1 }) }}</span>
        <button type="button" class="ai-icon-btn" :aria-label="t('preview.nextPage')" :disabled="loading || page >= (content.pages ?? 1)" @click="changePage(page + 1)"><ChevronRight /></button>
      </nav>
      <nav v-if="offsets.length || content.nextOffset !== undefined" :aria-label="t('preview.chunks')">
        <button type="button" class="ai-btn" :disabled="loading || !offsets.length" @click="previousChunk">{{ t("preview.previousChunk") }}</button>
        <span>{{ t("preview.characters", { start: content.offset + 1, end: content.offset + (content.text?.length ?? 0), total: content.totalChars ?? 0 }) }}</span>
        <button type="button" class="ai-btn" :disabled="loading || content.nextOffset === undefined" @click="nextChunk">{{ t("preview.nextChunk") }}</button>
      </nav>
    </footer>
  </dialog>
</template>

<style>
.ai-resource-preview {
  position: fixed;
  inset: 0;
  z-index: calc(var(--ai-z) + 10);
  box-sizing: border-box;
  width: min(960px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
  margin: auto;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--vc-border);
  border-radius: var(--vc-radius);
  background: var(--vc-bg);
  color: var(--vc-fg);
}
.ai-resource-preview[open] { display: flex; flex-direction: column; }
.ai-resource-preview::backdrop { background: rgb(0 0 0 / 45%); }
.ai-preview-header { display: flex; flex: none; align-items: center; gap: 8px; min-width: 0; padding: 8px 12px; border-bottom: 1px solid var(--vc-border); }
.ai-preview-header h2 { flex: 1; min-width: 0; margin: 0; font-size: 14px; }
.ai-preview-header a { flex: none; text-decoration: none; }
.ai-preview-header a svg { width: 14px; height: 14px; }
.ai-preview-body { min-height: 80px; padding: 12px; overflow: auto; overscroll-behavior: contain; }
.ai-preview-body img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.ai-preview-body pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; font-family: var(--vc-font-mono, monospace); }
.ai-preview-body img + pre { margin-top: 12px; }
.ai-preview-error { color: var(--vc-danger); }
.ai-preview-footer { display: flex; flex: none; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 8px; border-top: 1px solid var(--vc-border); }
.ai-preview-footer nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px; font-size: 12px; }
@media (max-width: 480px) {
  .ai-resource-preview { width: calc(100vw - 12px); max-width: calc(100vw - 12px); max-height: calc(100dvh - 12px); }
  .ai-preview-header { gap: 4px; padding: 6px; }
  .ai-preview-body { padding: 8px; }
}
</style>
