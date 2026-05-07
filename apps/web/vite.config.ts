import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
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
      // Sparse UI tests today; raise toward 80% as feature tests grow.
      thresholds: { lines: 20 }
    }
  }
});
