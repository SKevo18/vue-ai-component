<script setup lang="ts">
import { Moon, Sparkles, Sun, X } from "@lucide/vue";
import { ref, watch } from "vue";
import { AiSettings, AiSidebar, useAi } from "../src";
import { context, locale, opened, settingsOpen, toolHost } from "./state";

const ai = useAi();
const open = ref(true);
const width = ref(0);
const dark = ref(matchMedia("(prefers-color-scheme: dark)").matches);
watch(dark, (v) => (document.documentElement.dataset.theme = v ? "dark" : "light"), { immediate: true });

const burrows = [
  { uri: "burrow://1", label: "Mossy Hollow" },
  { uri: "burrow://2", label: "Clover Den" },
  { uri: "burrow://3", label: "Rooty Nook" },
];

function openBurrow(b: { uri: string; label: string }) {
  context.value = [{ ...b, icon: "folder" }];
}

async function simulateRelay() {
  await toolHost.handle({ type: "browser_call", id: crypto.randomUUID(), op: "page.title" });
}
</script>

<template>
  <div class="pg" :style="{ paddingRight: open ? `${width}px` : '0px' }">
    <header class="pg-header">
      <strong>Otterfield registry</strong>
      <span class="pg-spacer" />
      <select v-model="locale" aria-label="Language"><option value="en">EN</option><option value="sk">SK</option></select>
      <button type="button" class="pg-btn" :aria-label="dark ? 'Light theme' : 'Dark theme'" @click="dark = !dark"><Sun v-if="dark" /><Moon v-else /></button>
      <button type="button" class="pg-btn" aria-label="Assistant" :aria-pressed="open" @click="open = !open"><Sparkles /></button>
    </header>
    <main class="pg-main">
      <h1>Burrows</h1>
      <p>Click a burrow to make it the open context. The assistant gets it as a chip.</p>
      <ul class="pg-list">
        <li v-for="b in burrows" :key="b.uri">
          <button type="button" :class="{ active: context[0]?.uri === b.uri }" @click="openBurrow(b)">{{ b.label }} <code>{{ b.uri }}</code></button>
        </li>
      </ul>
      <p class="pg-row"><button type="button" class="pg-text-btn" @click="settingsOpen = true">AI settings</button><button type="button" class="pg-text-btn" @click="simulateRelay">Simulate a browser call</button></p>
      <section v-if="opened.length" class="pg-opened">
        <h2>Opened resources</h2>
        <ul>
          <li v-for="(u, i) in opened" :key="i"><code>{{ u }}</code></li>
        </ul>
      </section>
      <p class="pg-muted pg-row">
        <span>Tab id <code>{{ toolHost.tabId }}</code></span>
        <span>MCP server <code>{{ ai.state.mcp.burrows?.info?.serverInfo.name ?? "not connected yet" }}</code></span>
      </p>
      <p v-for="i in 12" :key="i" class="pg-muted">Filler paragraph {{ i }} so the page can scroll behind the sheet. Badgers dig, otters swim, herons wait.</p>
    </main>
    <AiSidebar v-model:open="open" @width="width = $event" />
    <div v-if="settingsOpen" class="pg-modal" @click.self="settingsOpen = false">
      <div class="pg-dialog" role="dialog" aria-label="AI settings">
        <header><strong>AI settings</strong><button type="button" class="pg-btn" aria-label="Close" @click="settingsOpen = false"><X /></button></header>
        <AiSettings>
          <template #after><p class="pg-muted">App-only settings can go here.</p></template>
        </AiSettings>
      </div>
    </div>
  </div>
</template>
