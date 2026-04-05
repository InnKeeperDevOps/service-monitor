import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Browser bundle only needs workflow types; the package barrel pulls in node:crypto via dedup.
    alias: {
      "@sm/domain": path.resolve(dir, "../../packages/domain/src/workflow.ts")
    }
  },
  build: {
    outDir: "dist"
  },
  test: {
    include: ["test/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 80 }
    }
  }
});
