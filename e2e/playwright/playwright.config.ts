import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const webAppDir = path.join(repoRoot, "apps/web");

/**
 * Browser E2E. Default: serve built web app on 127.0.0.1:5173 via `vite preview`.
 * Set BASE_URL to use another origin (e.g. staging); webServer is skipped in that case.
 * Set PW_SKIP_WEBSERVER=1 to disable auto-start (you must run the app yourself).
 */
const baseURL = process.env.BASE_URL?.trim() || "http://127.0.0.1:5173";
const skipWebServer = process.env.PW_SKIP_WEBSERVER === "1";
const useExternalBaseUrl = Boolean(process.env.BASE_URL?.trim());

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html"], ["line"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer:
    skipWebServer || useExternalBaseUrl
      ? undefined
      : {
          command:
            "(test -d dist || pnpm exec vite build) && pnpm exec vite preview --host 127.0.0.1 --port 5173",
          cwd: webAppDir,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
});
