import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E (E2E-001–006). Set BASE_URL to the running web app (e.g. http://localhost:5173).
 * Specs skip when BASE_URL is unset so CI/local runs stay safe without a server.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html"], ["line"]] : "list",
  use: {
    baseURL: process.env.BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
