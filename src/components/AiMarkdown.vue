<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ai } from "../ai";
import { createTranslator } from "../i18n";
import { renderMarkdown, sanitizeHtml } from "../ui/markdown";

const props = defineProps<{
  source: string;
  streaming?: boolean;
  ai?: Ai;
}>();
const emit = defineEmits<{ resource: [uri: string] }>();

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const fallback = createTranslator("en").t;

function render(text: string): string {
  const custom = props.ai?.options.markdown;
  return custom ? sanitizeHtml(custom(text)) : renderMarkdown(text);
}

const root = ref<HTMLElement | null>(null);
const html = ref(render(props.source));
let frame = 0;

watch(
  () => props.source,
  (text) => {
    if (!props.streaming) {
      cancelAnimationFrame(frame);
      html.value = render(text);
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      html.value = render(props.source);
    });
  },
);
watch(
  () => props.streaming,
  (on) => {
    if (on) return;
    cancelAnimationFrame(frame);
    frame = 0;
    html.value = render(props.source);
  },
);

function setButton(button: HTMLButtonElement, copied: boolean) {
  const label = (props.ai?.t ?? fallback)(copied ? "copied" : "copy");
  button.innerHTML = copied ? CHECK_ICON : COPY_ICON;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.toggle("ai-copied", copied);
}

/** gives every code block a copy button; v-html replaces the DOM on each render */
function decorate() {
  for (const pre of root.value?.querySelectorAll("pre") ?? []) {
    if (pre.parentElement?.classList.contains("ai-code-block")) continue;
    const block = document.createElement("div");
    block.className = "ai-code-block";
    pre.replaceWith(block);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-code-copy";
    button.dataset.aiCopy = "";
    setButton(button, false);
    block.append(pre, button);
  }
}
watch(html, decorate, { flush: "post" });
onMounted(decorate);

const timers = new Set<ReturnType<typeof setTimeout>>();
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  for (const timer of timers) clearTimeout(timer);
});

async function copy(button: HTMLButtonElement) {
  const pre = button.parentElement?.querySelector("pre");
  const text = pre?.querySelector("code")?.textContent ?? pre?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  setButton(button, true);
  const timer = setTimeout(() => {
    timers.delete(timer);
    setButton(button, false);
  }, 1500);
  timers.add(timer);
}

function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>("button[data-ai-copy]");
  if (button) {
    void copy(button);
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a[data-ai-resource]");
  if (!link) return;
  e.preventDefault();
  const uri = link.dataset.aiResource!;
  emit("resource", uri);
  props.ai?.openResource(uri);
}
</script>

<template>
  <div ref="root" class="ai-md" :class="{ 'ai-streaming': streaming }" @click="onClick" v-html="html" />
</template>

<style>
.ai-md {
  min-width: 0;
  color: var(--vc-fg);
  overflow-wrap: anywhere;
}
.ai-md > :first-child {
  margin-top: 0;
}
.ai-md > :last-child {
  margin-bottom: 0;
}
.ai-md :is(p, ul, ol, pre, blockquote, table) {
  margin: 0 0 0.6em;
}
.ai-md :is(ul, ol) {
  padding-left: 1.3em;
}
.ai-md li + li {
  margin-top: 0.15em;
}
.ai-md :is(h1, h2, h3, h4) {
  margin: 0.9em 0 0.4em;
  color: var(--vc-fg-strong);
  font-size: 1em;
  font-weight: 650;
  line-height: 1.35;
}
.ai-md h1 {
  font-size: 1.2em;
}
.ai-md h2 {
  font-size: 1.1em;
}
.ai-md a {
  color: var(--vc-accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--vc-accent) 40%, transparent);
  text-underline-offset: 2px;
}
.ai-md code {
  padding: 0.1em 0.3em;
  border-radius: 4px;
  background: var(--vc-code-bg);
  color: var(--vc-code-fg);
  font-family: var(--vc-font-mono);
  font-size: 0.9em;
}
.ai-md pre {
  overflow-x: auto;
  padding: 8px 10px;
  border-radius: var(--vc-radius-sm);
  background: var(--vc-code-bg);
  color: var(--vc-code-fg);
  font-size: 12.5px;
  line-height: 1.45;
}
.ai-md pre code {
  padding: 0;
  background: none;
  font-size: inherit;
}
.ai-code-block {
  position: relative;
  margin: 0 0 0.6em;
}
.ai-md > .ai-code-block:last-child {
  margin-bottom: 0;
}
.ai-md .ai-code-block pre {
  margin: 0;
}
.ai-code-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  background: var(--vc-bg);
  color: var(--vc-fg-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}
.ai-code-block:hover .ai-code-copy,
.ai-code-copy:focus-visible,
.ai-code-copy.ai-copied {
  opacity: 1;
}
.ai-code-copy:hover {
  color: var(--vc-fg-strong);
}
.ai-code-copy.ai-copied {
  color: var(--vc-success);
}
.ai-code-copy svg {
  width: 13px;
  height: 13px;
}
@media (hover: none) {
  .ai-code-copy {
    opacity: 1;
  }
}
.ai-md blockquote {
  padding-left: 10px;
  border-left: 3px solid var(--vc-border-strong);
  color: var(--vc-fg-muted);
}
.ai-md table {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 12.5px;
}
.ai-md :is(th, td) {
  padding: 4px 8px;
  border: 1px solid var(--vc-border);
  text-align: left;
}
.ai-md hr {
  margin: 0.8em 0;
  border: 0;
  border-top: 1px solid var(--vc-border);
}
.ai-md img {
  max-width: 100%;
}
.ai-md.ai-streaming > :last-child::after {
  content: "";
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  border-radius: 1px;
  background: var(--vc-accent);
  animation: ai-caret 1s steps(2) infinite;
}
@keyframes ai-caret {
  50% {
    opacity: 0;
  }
}
</style>
