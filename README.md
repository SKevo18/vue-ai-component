# @skevo18/vue-ai-component

A chat sidebar and agent harness for Vue 3 apps that runs the model loop in the browser. It talks to model vendors through your backend or with keys stored in the browser, and reaches your app's data and actions only through your MCP server, asking the user before writes. It exists so an app can add an assistant without running agent code on its server.

## Usage

```sh
bun add github:SKevo18/vue-ai-component
```

Peer dependencies: `vue` ^3.5 and `@lucide/vue`.

```ts
import { createApp, h } from "vue";
import { AiSidebar, createAi, createBrowserKeys } from "@skevo18/vue-ai-component";
import "@skevo18/vue-ai-component/style.css";

const ai = createAi({ backend: createBrowserKeys(), mcp: { url: "/api/mcp" } });
createApp({ render: () => h(AiSidebar) }).use(ai).mount("#app");
```

## License

MIT
