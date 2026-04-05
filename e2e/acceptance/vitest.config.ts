import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 150_000,
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 80, branches: 50, functions: 80, statements: 80 }
    }
  }
});
