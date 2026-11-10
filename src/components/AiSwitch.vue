<script setup lang="ts">
defineProps<{ label?: string; disabled?: boolean }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="ai-switch" :class="{ 'ai-disabled': disabled }">
    <input v-model="model" type="checkbox" role="switch" :disabled="disabled" :aria-checked="model" />
    <span class="ai-switch-track" aria-hidden="true" />
    <span v-if="label || $slots.default" class="ai-switch-label"><slot>{{ label }}</slot></span>
  </label>
</template>
