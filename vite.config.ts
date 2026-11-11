import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import pkg from "./package.json" with { type: "json" };

const external = [...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies), "vite"];

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      // ./code and ./vite share nothing with the main entry, so hosts that do not import them bundle nothing extra
      entry: { index: "src/index.ts", code: "src/code/index.ts", "code-worker": "src/code/worker/index.ts", vite: "src/vite.ts" },
      formats: ["es"],
      fileName: (_, entry) => `${entry}.js`,
      cssFileName: "style",
    },
    rolldownOptions: {
      external: (id) => id.startsWith("node:") || external.some((name) => id === name || id.startsWith(`${name}/`)),
    },
    sourcemap: false,
    minify: false,
    emptyOutDir: true,
  },
});
