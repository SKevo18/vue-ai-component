<script setup lang="ts">
import { ClipboardPaste, Copy, ExternalLink, LogOut, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import type { Ai } from "../ai";
import { clipboardSignInCode, pastedSignInCode } from "../backend/login";
import type { AiConnection } from "../backend/types";
import { errorText } from "../core/types";
import { safeLink } from "../ui/links";
import { vTooltip } from "../ui/tooltip";

const props = defineProps<{ connection: AiConnection; ai: Ai }>();
const t = props.ai.t;
const backend = props.ai.options.backend;

type Flow = { kind: "idle" } | { kind: "starting" } | { kind: "device"; url: string; code: string } | { kind: "paste"; url: string; hint?: string } | { kind: "confirm-logout" };
const flow = ref<Flow>({ kind: "idle" });
const error = ref("");
const pasted = ref("");
const busy = ref(false);
const copied = ref(false);
const vendor = computed(() => props.connection.name);
let controller: AbortController | null = null;
let tried = "";

function reset() {
  controller?.abort();
  controller = null;
  window.removeEventListener("focus", checkClipboard);
  flow.value = { kind: "idle" };
  pasted.value = "";
  tried = "";
  busy.value = false;
}

async function connected() {
  reset();
  await props.ai.refreshConnections();
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => (clearTimeout(timer), reject(new DOMException("aborted", "AbortError"))), { once: true });
  return promise;
}

async function poll(interval: number, expiresIn: number | undefined) {
  controller = new AbortController();
  const signal = controller.signal;
  const deadline = Date.now() + (expiresIn ?? 900) * 1000;
  while (!signal.aborted) {
    await wait(Math.max(1, interval) * 1000, signal);
    if (Date.now() > deadline) {
      reset();
      error.value = t("connections.expired");
      return;
    }
    const result = await backend.completeLogin!(props.connection.id);
    if (signal.aborted) return;
    if (result === "connected") return connected();
  }
}

async function begin() {
  error.value = "";
  // a tab opened inside the click is not blocked as a popup; it is navigated once the address is known
  const tab = props.connection.login === "paste" ? window.open("", "_blank") : null;
  flow.value = { kind: "starting" };
  try {
    const start = await backend.startLogin!(props.connection.id);
    const url = safeLink(start.url);
    if (!url) throw new Error(t("connections.badLink"));
    if (start.kind === "device") {
      flow.value = { kind: "device", url, code: start.code };
      await poll(start.interval, start.expiresIn);
    } else {
      flow.value = { kind: "paste", url, hint: start.hint };
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      }
      window.addEventListener("focus", checkClipboard);
    }
  } catch (e) {
    tab?.close();
    if ((e as Error)?.name === "AbortError") return;
    reset();
    error.value = errorText(e);
  }
}

function openDevice() {
  if (flow.value.kind !== "device") return;
  void navigator.clipboard?.writeText(flow.value.code).catch(() => undefined);
  window.open(flow.value.url, "_blank", "noopener");
}

async function copyCode() {
  if (flow.value.kind !== "device") return;
  try {
    await navigator.clipboard.writeText(flow.value.code);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // copying is a convenience, the code stays visible
  }
}

async function submit(code: string) {
  if (flow.value.kind !== "paste" || busy.value || code === tried) return;
  tried = code;
  busy.value = true;
  error.value = "";
  try {
    const result = await backend.completeLogin!(props.connection.id, code);
    if (result === "connected") await connected();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

function onInput() {
  const code = pastedSignInCode(pasted.value);
  if (code) void submit(code);
}

async function readClipboard(strict: boolean) {
  if (flow.value.kind !== "paste" || !navigator.clipboard?.readText) return;
  try {
    const text = await navigator.clipboard.readText();
    const code = strict ? clipboardSignInCode(text) : pastedSignInCode(text);
    if (code && code !== tried) {
      pasted.value = code;
      void submit(code);
    }
  } catch {
    // reading the clipboard is optional, pasting works without it
  }
}

async function checkClipboard() {
  const permission = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName }).catch(() => null);
  if (permission?.state === "granted") void readClipboard(true);
}

async function logout() {
  flow.value = { kind: "idle" };
  try {
    await backend.logout!(props.connection.id);
    await props.ai.refreshConnections();
  } catch (e) {
    error.value = errorText(e);
  }
}

onBeforeUnmount(reset);
</script>

<template>
  <div class="ai-card">
    <div class="ai-card-row">
      <div class="ai-card-name">
        <span class="ai-card-title">{{ connection.name }}</span>
        <span class="ai-card-status ai-truncate" :class="{ 'ai-on': connection.connected }">
          {{ connection.connected ? connection.account || t("connections.connected") : connection.note || t("connections.notConnected") }}
        </span>
      </div>
      <template v-if="connection.connected">
        <template v-if="flow.kind === 'confirm-logout'">
          <button type="button" class="ai-btn ai-sm ai-danger" @click="logout"><LogOut />{{ t("connections.signOut") }}</button>
          <button v-tooltip="t('connections.cancel')" type="button" class="ai-icon-btn ai-sm" @click="flow = { kind: 'idle' }"><X /></button>
        </template>
        <button v-else-if="backend.logout" v-tooltip="t('connections.signOut')" type="button" class="ai-icon-btn" @click="flow = { kind: 'confirm-logout' }"><LogOut /></button>
      </template>
      <button v-else-if="flow.kind === 'idle' || flow.kind === 'starting'" type="button" class="ai-btn ai-sm" :disabled="flow.kind === 'starting' || !backend.startLogin" @click="begin">
        <span v-if="flow.kind === 'starting'" class="ai-spinner" />{{ t("connections.signIn") }}
      </button>
      <button v-else v-tooltip="t('connections.cancel')" type="button" class="ai-icon-btn" @click="reset"><X /></button>
    </div>
    <p v-if="connection.description" class="ai-card-desc">{{ connection.description }}</p>
    <p v-if="connection.warning" class="ai-card-warning" role="note">{{ connection.warning }}</p>
    <div v-if="flow.kind === 'device'" class="ai-card-flow">
      <p class="ai-card-hint">{{ t("connections.deviceStep", { name: vendor }) }}</p>
      <div class="ai-device">
        <span class="ai-device-code">{{ flow.code }}</span>
        <button v-tooltip="copied ? t('connections.copied') : t('connections.copy')" type="button" class="ai-icon-btn ai-sm" @click="copyCode"><Copy /></button>
        <button type="button" class="ai-btn ai-primary ai-sm" @click="openDevice"><ExternalLink />{{ t("connections.open", { name: vendor }) }}</button>
      </div>
      <p class="ai-card-wait"><span class="ai-spinner" />{{ t("connections.waiting") }}</p>
    </div>
    <div v-else-if="flow.kind === 'paste'" class="ai-card-flow">
      <p class="ai-card-hint">{{ flow.hint || t("connections.pasteStep", { name: vendor }) }}</p>
      <div class="ai-paste">
        <input
          v-model="pasted"
          class="ai-input ai-mono"
          :placeholder="t('connections.pastePlaceholder')"
          :aria-label="t('connections.pastePlaceholder')"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          @input="onInput"
          @keydown.enter.prevent="pastedSignInCode(pasted) && submit(pastedSignInCode(pasted)!)"
        />
        <span v-if="busy" class="ai-spinner" />
        <template v-else>
          <button v-tooltip="t('connections.pasteFromClipboard')" type="button" class="ai-icon-btn ai-sm" @click="readClipboard(false)"><ClipboardPaste /></button>
          <a v-tooltip="t('connections.open', { name: vendor })" :href="flow.url" target="_blank" rel="noopener" class="ai-icon-btn ai-sm"><ExternalLink /></a>
        </template>
      </div>
    </div>
    <p v-if="error" class="ai-card-error">{{ error }}</p>
  </div>
</template>
