import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: "dist"
  },
  server: {
    allowedHosts: ["localhost", "127.0.0.1", "panel.kaiad.dev"]
  },
  preview: {
    allowedHosts: ["localhost", "127.0.0.1", "panel.kaiad.dev"]
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 20 }
    }
  }
});
