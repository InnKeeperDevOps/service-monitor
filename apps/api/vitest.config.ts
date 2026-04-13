import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // See server.ts onRequest: allows /api/v1/* without DATABASE_URL when VITEST=true.
      KAIAD_SKIP_SETUP_GATE: "1",
      SM_ENROLLMENT_STORE: "memory"
    },
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["scripts/**", "test/**", "node_modules/**", "dist/**", "public/**", "vitest.config.ts"],
      // server.ts integration surface is large; raise toward 80% with focused tests.
      // server/setup/enrollment paths grew; raise as coverage on those modules improves.
      thresholds: { lines: 80 }
    }
  }
});
