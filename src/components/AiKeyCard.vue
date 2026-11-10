<script setup lang="ts">
import { ExternalLink, Eye, EyeOff, Trash2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type { Ai } from "../ai";
import type { AiConnection } from "../backend/types";
import { errorText } from "../core/types";
import { safeLink } from "../ui/links";
import { vTooltip } from "../ui/tooltip";

const props = defineProps<{ connection: AiConnection; ai: Ai }>();
const t = props.ai.t;
const backend = props.ai.options.backend;
const key = ref("");
const busy = ref(false);
const error = ref("");
const visible = ref(false);
const testing = ref(false);
const modelCount = ref<number | null>(null);
const keysUrl = computed(() => safeLink(props.connection.keysUrl));
const usageUrl = computed(() => safeLink(props.connection.usageUrl));
watch(() => props.connection.connected, () => {
  modelCount.value = null;
  error.value = "";
  visible.value = false;
});

async function testKey() {
  if (busy.value || !props.connection.connected) return;
  busy.value = true;
  testing.value = true;
  error.value = "";
  modelCount.value = null;
  try {
    const models = await backend.models(props.connection.id);
    if (props.connection.connected) modelCount.value = models.length;
  } catch (e) {
    if (props.connection.connected) error.value = t("errors.rejectedKey", { message: errorText(e) });
  } finally {
    testing.value = false;
    busy.value = false;
  }
}

async function save(value: string | null) {
  if (!backend.saveKey || busy.value) return;
  busy.value = true;
  error.value = "";
  modelCount.value = null;
  try {
    await backend.saveKey(props.connection.id, value);
    key.value = "";
    visible.value = false;
    await props.ai.refreshConnections();
    if (value) await props.ai.loadModels(props.connection.id, true);
  } catch (e) {
    error.value = value ? t("errors.rejectedKey", { message: errorText(e) }) : errorText(e);
  } finally {
    busy.value = false;
  }
}
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
      <a v-if="keysUrl && !connection.connected" v-tooltip="t('connections.getKey')" :aria-label="t('connections.getKey')" :href="keysUrl" target="_blank" rel="noopener noreferrer" class="ai-icon-btn"><ExternalLink /></a>
      <a v-if="usageUrl && connection.connected" v-tooltip="t('connections.usage')" :aria-label="t('connections.usage')" :href="usageUrl" target="_blank" rel="noopener noreferrer" class="ai-icon-btn"><ExternalLink /></a>
      <button v-if="connection.connected" type="button" class="ai-btn ai-sm" :disabled="busy" @click="testKey">
        <span v-if="testing" class="ai-spinner" />{{ testing ? t("connections.testing") : t("connections.testKey") }}
      </button>
      <button v-if="connection.connected && backend.saveKey" v-tooltip="t('connections.removeKey')" :aria-label="t('connections.removeKey')" type="button" class="ai-icon-btn" :disabled="busy" @click="save(null)"><Trash2 /></button>
    </div>
    <p v-if="connection.description" class="ai-card-desc">{{ connection.description }}</p>
    <p v-if="connection.warning" class="ai-card-warning" role="note">{{ connection.warning }}</p>
    <form v-if="!connection.connected && backend.saveKey" class="ai-paste" @submit.prevent="key.trim() && save(key)">
      <input
        v-model="key"
        class="ai-input ai-mono"
        :type="visible ? 'text' : 'password'"
        :placeholder="t('connections.keyPlaceholder')"
        :aria-label="t('connections.keyPlaceholder')"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
      />
      <button v-tooltip="visible ? t('connections.hideKey') : t('connections.showKey')" type="button" class="ai-icon-btn" :aria-label="visible ? t('connections.hideKey') : t('connections.showKey')" :aria-pressed="visible" :disabled="busy" @click="visible = !visible">
        <EyeOff v-if="visible" /><Eye v-else />
      </button>
      <button type="submit" class="ai-btn ai-sm" :disabled="busy || !key.trim()">
        <span v-if="busy" class="ai-spinner" />{{ busy ? t("connections.saving") : t("connections.save") }}
      </button>
    </form>
    <p v-if="modelCount !== null" class="ai-card-desc" role="status">{{ t("connections.testSuccess", { count: modelCount }) }}</p>
    <p v-if="error" class="ai-card-error" role="alert">{{ error }}</p>
  </div>
</template>
