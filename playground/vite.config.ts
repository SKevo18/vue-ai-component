import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { hasGo, startFixture, type Fixture } from "../test/fixture-server.ts";

const FIXTURE_ADDR = process.env.FIXTURE_ADDR ?? "127.0.0.1:18431";

function fixture(): Plugin {
  let running: Fixture | null = null;
  return {
    name: "mcp-fixture",
    apply: "serve",
    async config() {
      if (!hasGo()) {
        console.warn("go is not installed: the playground runs without the fixture MCP server");
        return {};
      }
      running = await startFixture(FIXTURE_ADDR);
      const target = new URL(running.url).origin;
      return { server: { proxy: { "/mcp": { target, changeOrigin: true } } } };
    },
    configureServer(server) {
      server.httpServer?.once("close", () => void running?.stop());
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void running?.stop().then(() => process.exit(0)));
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue(), fixture()],
  server: { port: Number(process.env.PORT ?? 15180), strictPort: true, host: "127.0.0.1" },
});
