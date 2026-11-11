# @skevo18/vue-ai-component

A chat sidebar and agent harness for Vue 3 apps that runs the model loop in the browser. It talks to model vendors through your backend or with keys stored in the browser, and reaches data and actions only through the MCP servers you name, asking the user before writes. It exists so an app can add an assistant without running agent code on its server.

## Usage

```sh
bun add github:SKevo18/vue-ai-component
```

Peer dependencies: `vue` ^3.5 and `@lucide/vue`.

```ts
import { createApp, h } from "vue";
import { AiSidebar, createAi, createBrowserKeys } from "@skevo18/vue-ai-component";
import "@skevo18/vue-ai-component/style.css";

const ai = createAi({ backend: createBrowserKeys(), mcp: { app: { url: "/api/mcp" }, docs: { url: "https://docs.example.com/mcp", credentials: "omit" } } });
createApp({ render: () => h(AiSidebar) }).use(ai).mount("#app");
```

## Subscription sign-ins

Users can sign in with plans they already have (ChatGPT through Codex or Sign in with ChatGPT, Claude, Google Antigravity) instead of pasting API keys. The vendors only redirect to their own pages, so the sign-in runs on your server: the Go package `github.com/SKevo18/vue-ai-component/go/aiserver` (directory `go/`) runs the OAuth flows, refreshes tokens and proxies the chat requests, and the app plugs in the signed-in user, a store that seals the credentials, an optional per-provider gate and error rendering. The package ships no Google client: pass the Antigravity OAuth client in `Config.Antigravity`, or that provider is not offered.

```go
h := aiserver.New(aiserver.Config{
	Prefix:     "/api/ai/",
	Providers:  []string{aiserver.Codex, aiserver.Claude, aiserver.Antigravity},
	User:       func(r *http.Request) (string, error) { return currentUserID(r) },
	Store:      credentialStore{}, // Accounts, Load, Save, Delete
	Originator: "myapp",
})
mux.Handle("/api/ai/", h)
```

In the browser, sign-ins come first and browser-held API keys stay a secondary option:

```ts
const backend = mergeBackends(createServerBackend({ baseUrl: "/api/ai" }), createBrowserKeys());
```

`aiservertest` has fake vendors for the app's own tests.

## License

MIT
