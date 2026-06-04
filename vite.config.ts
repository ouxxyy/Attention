import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json";
import { resolve } from "path";

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/popup.html"),
        options: resolve(__dirname, "src/options/options.html"),
        dashboard: resolve(__dirname, "src/dashboard/dashboard.html"),
        content: resolve(__dirname, "src/content/content.ts"),
        background: resolve(__dirname, "src/background/background.ts"),
      },
    },
  },
});
