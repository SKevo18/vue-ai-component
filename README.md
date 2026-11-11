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

Tools that run in the tab go in `tools` next to the MCP servers, with the same approval tiers (`approval: "auto" | "ask" | "confirm"`). Their `run(args, ctx)` gets the chat's attachments with their bytes from `ctx.files()`. A failing or silent MCP server never blocks a run: its tools are left out and the notice about it can be closed (`ai.dismissError("tools")`).

## Running code

`@skevo18/vue-ai-component/code` adds `run_code`: Python (Pyodide) and JavaScript in workers of the tab, one workspace per conversation, attachments mounted as `attachments/<name>`, matplotlib figures and shown images returned as images. Apps that do not import it bundle none of it.

```sh
bun add pyodide   # optional peer, only for Python
```

```ts
// vite.config.ts: serves the workers, Pyodide and its numpy, pandas and matplotlib wheels from /assets/
import { codeAssets } from "@skevo18/vue-ai-component/vite";
export default defineConfig({ plugins: [codeAssets(), vue()] });

// the assistant
import { createCodeTool } from "@skevo18/vue-ai-component/code";
createAi({ backend, tools: [createCodeTool({ assetsUrl: "/assets/code/", pyodideUrl: "/assets/pyodide/" })] });
```

The app server serves `/assets/code/` with `CODE_WORKER_CSP` from `./vite` (`script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'`), and the page's policy needs `worker-src 'self'`. The workers reach nothing but the Pyodide folder. Apps with their own kernels (other runtimes, package policies, time limits) build workers from `@skevo18/vue-ai-component/code/worker` and pass `kernel` to `createCodeTool`; `mounts` copies the app's own files into the workspace.

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
