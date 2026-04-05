import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // server.ts integration surface is large; raise toward 80% with focused tests.
      thresholds: { lines: 73 }
    }
  }
});
