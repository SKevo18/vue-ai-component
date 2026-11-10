<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { Ai } from "../ai";
import { errorText } from "../core/types";
import { useAiInstance } from "../ui/composables";
import AiKeyCard from "./AiKeyCard.vue";
import AiLoginCard from "./AiLoginCard.vue";
import AiSwitch from "./AiSwitch.vue";

const props = defineProps<{ ai?: Ai }>();
const ai = useAiInstance(props);
const t = ai.t;
const state = ai.state;

const visible = computed(() => state.connections.filter((c) => c.enabled || c.connected));
const subscriptions = computed(() => visible.value.filter((c) => c.kind === "subscription"));
const keys = computed(() => visible.value.filter((c) => c.kind === "key"));
const sites = computed(() => visible.value.filter((c) => c.kind === "site"));
const usable = computed(() => state.connections.filter((c) => c.enabled && c.connected));
const models = computed(() => (ai.connection ? state.models[ai.connection.id] : undefined));
const customModel = ref("");
const confirmingClear = ref(false);
const clearing = ref(false);
const clearError = ref("");

async function clearBrowserKeys() {
  if (!ai.options.backend.clearBrowserKeys || clearing.value) return;
  clearing.value = true;
  clearError.value = "";
  try {
    await ai.options.backend.clearBrowserKeys();
    await ai.refreshConnections();
    confirmingClear.value = false;
  } catch (e) {
    clearError.value = errorText(e);
  } finally {
    clearing.value = false;
  }
}

const autoWrites = computed({ get: () => state.preferences.autoApproveWrites, set: (v: boolean) => void ai.setPreferences({ autoApproveWrites: v }) });
const autoExternal = computed({ get: () => state.preferences.autoApproveExternal, set: (v: boolean) => void ai.setPreferences({ autoApproveExternal: v }) });

function pickModel(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  if (ai.connection && value) void ai.select(ai.connection.id, value);
}

function useCustom() {
  const m = customModel.value.trim();
  if (ai.connection && m) void ai.select(ai.connection.id, m);
  customModel.value = "";
}

watch(
  () => ai.connection?.id,
  (id) => id && void ai.loadModels(id),
  { immediate: true },
);
onMounted(() => void ai.init().then(() => ai.refreshConnections()));
</script>

<template>
  <div class="ai-root ai-settings">
    <slot name="before" />
    <div v-if="!state.connectionsLoaded" class="ai-settings-loading"><span class="ai-spinner" /></div>
    <template v-else>
      <p v-if="state.connectionsError" class="ai-card-error">{{ state.connectionsError }}</p>
      <p v-else-if="!visible.length" class="ai-settings-hint">{{ t("connections.noConnections") }}</p>

      <section v-if="sites.length" class="ai-settings-section">
        <h3>{{ t("connections.site") }}</h3>
        <div class="ai-cards">
          <div v-for="c in sites" :key="c.id" class="ai-card">
            <div class="ai-card-row">
              <div class="ai-card-name">
                <span class="ai-card-title">{{ c.name }}</span>
                <span class="ai-card-status ai-truncate" :class="{ 'ai-on': c.connected }">{{ c.note || (c.connected ? t("connections.connected") : t("connections.notConnected")) }}</span>
              </div>
            </div>
            <p v-if="c.description" class="ai-card-desc">{{ c.description }}</p>
            <p v-if="c.warning" class="ai-card-warning" role="note">{{ c.warning }}</p>
          </div>
        </div>
      </section>

      <section v-if="subscriptions.length" class="ai-settings-section">
        <h3>{{ t("connections.subscriptions") }}</h3>
        <p class="ai-settings-hint">{{ t("connections.subscriptionsHint") }}</p>
        <div class="ai-cards">
          <AiLoginCard v-for="c in subscriptions" :key="c.id" :connection="c" :ai="ai" />
        </div>
      </section>

      <section v-if="keys.length || ai.options.backend.clearBrowserKeys" class="ai-settings-section">
        <h3>{{ t("connections.keys") }}</h3>
        <p class="ai-settings-hint">{{ t("connections.keysHint") }}</p>
        <div v-if="keys.length" class="ai-cards">
          <AiKeyCard v-for="c in keys" :key="c.id" :connection="c" :ai="ai" />
        </div>
        <div v-if="ai.options.backend.clearBrowserKeys" class="ai-browser-keys-clear">
          <template v-if="confirmingClear">
            <p class="ai-settings-hint">{{ t("connections.clearBrowserKeysConfirm") }}</p>
            <div class="ai-model-row">
              <button type="button" class="ai-btn ai-sm ai-danger" :disabled="clearing" @click="clearBrowserKeys">
                <span v-if="clearing" class="ai-spinner" />{{ t("connections.clearBrowserKeys") }}
              </button>
              <button type="button" class="ai-btn ai-sm" :disabled="clearing" @click="confirmingClear = false">{{ t("connections.cancel") }}</button>
            </div>
          </template>
          <button v-else type="button" class="ai-btn ai-ghost ai-sm ai-danger" @click="confirmingClear = true">{{ t("connections.clearBrowserKeys") }}</button>
          <p v-if="clearError" class="ai-card-error" role="alert">{{ clearError }}</p>
        </div>
      </section>

      <section v-if="usable.length" class="ai-settings-section">
        <h3>{{ t("connections.assistant") }}</h3>
        <div class="ai-field">
          <span class="ai-field-label">{{ t("connections.provider") }}</span>
          <div class="ai-segments" role="radiogroup" :aria-label="t('connections.provider')">
            <button v-for="c in usable" :key="c.id" type="button" role="radio" class="ai-segment" :aria-checked="c.id === ai.connection?.id" @click="ai.select(c.id)">{{ c.name }}</button>
          </div>
        </div>
        <div v-if="ai.connection" class="ai-field">
          <label class="ai-field-label" for="ai-settings-model">{{ t("connections.model") }}</label>
          <div class="ai-model-row">
            <select id="ai-settings-model" class="ai-input" :value="ai.model" @change="pickModel">
              <option v-if="!models?.items.some((m) => m.id === ai.model)" :value="ai.model">{{ ai.model || t("model.choose") }}</option>
              <option v-for="m in models?.items ?? []" :key="m.id" :value="m.id">{{ m.name || m.id }}</option>
            </select>
            <span v-if="models?.loading" class="ai-spinner" />
          </div>
          <form class="ai-model-row" @submit.prevent="useCustom">
            <input v-model="customModel" class="ai-input" :placeholder="t('model.customPlaceholder')" :aria-label="t('model.customPlaceholder')" />
            <button type="submit" class="ai-btn ai-sm" :disabled="!customModel.trim()">{{ t("connections.save") }}</button>
          </form>
          <p v-if="models?.error" class="ai-card-error">{{ models.error }}</p>
        </div>
        <div class="ai-field ai-switches">
          <AiSwitch v-model="autoWrites" :label="t('connections.autoWrites')" />
          <AiSwitch v-model="autoExternal" :label="t('connections.autoExternal')" />
        </div>
      </section>
    </template>
    <slot name="after" />
  </div>
</template>

<style>
.ai-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 640px;
}
.ai-settings-loading {
  display: flex;
  justify-content: center;
  padding: 32px;
}
.ai-settings-section h3 {
  margin: 0 0 2px;
  color: var(--vc-fg-strong);
  font-size: 14px;
  font-weight: 650;
}
.ai-settings-hint {
  margin: 0 0 8px;
  color: var(--vc-fg-muted);
  font-size: 12.5px;
}
.ai-cards {
  overflow: hidden;
  border: 1px solid var(--vc-border);
  border-radius: var(--vc-radius);
  background: var(--vc-bg);
}
.ai-browser-keys-clear {
  margin-top: 8px;
}
.ai-card {
  padding: 10px 12px;
}
.ai-card + .ai-card {
  border-top: 1px solid var(--vc-border);
}
.ai-card-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.ai-card-name {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}
.ai-card-title {
  color: var(--vc-fg-strong);
  font-weight: 550;
}
.ai-card-status {
  color: var(--vc-fg-muted);
  font-size: 12px;
}
.ai-card-status.ai-on::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--vc-success);
  vertical-align: 1px;
}
.ai-card-flow {
  margin-top: 8px;
  padding: 10px;
  border-radius: var(--vc-radius-sm);
  background: var(--vc-bg-subtle);
}
.ai-card-hint {
  margin: 0 0 8px;
  color: var(--vc-fg-muted);
  font-size: 12.5px;
}
.ai-device {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ai-device-code {
  margin-right: 4px;
  color: var(--vc-fg-strong);
  font-family: var(--vc-font-mono);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.15em;
  user-select: all;
}
.ai-card-wait {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  color: var(--vc-fg-muted);
  font-size: 12px;
}
.ai-paste {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.ai-card-flow .ai-paste {
  margin-top: 0;
}
.ai-mono {
  font-family: var(--vc-font-mono);
  font-size: 12.5px;
}
.ai-card-desc {
  margin: 6px 0 0;
  color: var(--vc-fg-muted);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.ai-card-warning {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-left: 3px solid var(--vc-warning);
  border-radius: var(--vc-radius-sm);
  background: var(--vc-warning-soft);
  color: var(--vc-fg-strong);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.ai-card-error {
  margin: 6px 0 0;
  color: var(--vc-danger);
  font-size: 12.5px;
}
.ai-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.ai-field-label {
  color: var(--vc-fg-strong);
  font-size: 12.5px;
  font-weight: 550;
}
.ai-segments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-segment {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--vc-border-strong);
  border-radius: var(--vc-radius-sm);
  background: var(--vc-bg);
  color: var(--vc-fg);
  font: inherit;
  cursor: pointer;
}
.ai-segment[aria-checked="true"] {
  border-color: var(--vc-accent);
  background: var(--vc-accent-soft);
  color: var(--vc-fg-strong);
  font-weight: 550;
}
.ai-model-row {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 420px;
}
.ai-switches {
  gap: 10px;
  margin-top: 14px;
}
.ai-switches .ai-switch {
  align-items: flex-start;
}
.ai-switches .ai-switch-track {
  margin-top: 2px;
}
</style>
