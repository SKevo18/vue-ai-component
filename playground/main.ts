import { createApp } from "vue";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createAi } from "../src";
import App from "./App.vue";
import { playgroundBackend } from "./backend";
import { context, locale, opened, settingsOpen, toolHost } from "./state";
import "./playground.css";

const ai = createAi({
  backend: playgroundBackend(),
  mcp: { burrows: { url: "/mcp", headers: () => ({ Authorization: "Bearer otter-token" }) } },
  toolHost,
  context,
  locale,
  storagePrefix: "playground:",
  pdf: { workerSrc: pdfWorker },
  openResource: (uri) => (opened.value = [uri, ...opened.value].slice(0, 5)),
  openSettings: () => (settingsOpen.value = true),
  searchResources: async (q) => [1, 2, 3].filter((id) => `burrow ${id}`.includes(q.toLowerCase())).map((id) => ({ uri: `burrow://${id}`, label: `Burrow ${id}`, icon: "folder" })),
  suggestions: () => [
    { label: "Rename burrow 2", prompt: "rename burrow 2 to Fern Den" },
    { label: "Show a photo", prompt: "show me a photo of burrow 1" },
    { label: "Make a plan", prompt: "plan a badger census" },
  ],
});

createApp(App).use(ai).mount("#app");
