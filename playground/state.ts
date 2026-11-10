import { ref } from "vue";
import { createBrowserToolHost, type ContextItem } from "../src";

export const settingsOpen = ref(false);
export const opened = ref<string[]>([]);
export const context = ref<ContextItem[]>([{ uri: "burrow://1", label: "Mossy Hollow", icon: "folder" }]);
export const locale = ref<"en" | "sk">("en");

export const toolHost = createBrowserToolHost({
  respond: (id, result) => console.info("browser call answered", id, result),
  reportFocus: (state) => console.info("focus", state),
});
toolHost.register("page.title", () => document.title);
