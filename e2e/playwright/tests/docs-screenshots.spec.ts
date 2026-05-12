/**
 * Generates screenshots referenced from docs/.
 *
 * Run against a real Kaiad panel (your dev compose by default; staging
 * works too). Each capture navigates to a hash route, waits for a
 * stable signal (a heading or known element), then writes a PNG into
 * docs/assets/screenshots/ with the filename the markdown pages
 * reference.
 *
 *   KAIAD_DOCS_BASE_URL=http://127.0.0.1:8092 \
 *   KAIAD_DOCS_TOKEN=<owner-bearer-token> \
 *   PW_SKIP_WEBSERVER=1 \
 *   BASE_URL=http://127.0.0.1:8092 \
 *     pnpm --filter @sm/playwright-e2e exec playwright test docs-screenshots
 *
 * Without KAIAD_DOCS_TOKEN the suite skips every test (so default CI
 * doesn't fail on a missing live panel).
 *
 * Run against your DEV environment — these PNGs end up in the public
 * docs site. The capture spec doesn't redact anything; whatever the
 * panel shows lands in the PNG.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.resolve(
  __dirname,
  "../../../docs/assets/screenshots"
);

const docsToken = process.env.KAIAD_DOCS_TOKEN?.trim();
const docsBaseUrl = process.env.KAIAD_DOCS_BASE_URL?.trim();

// Skip everything when no token is configured. Avoids surprise failures
// in default `pnpm test` runs.
test.describe.configure({ mode: "serial" });
test.skip(!docsToken, "set KAIAD_DOCS_TOKEN to run docs-screenshot capture");

// Use the KAIAD_DOCS_BASE_URL if set (lets you point at a different
// origin than the Playwright default `BASE_URL`). Falls back to
// playwright.config's baseURL otherwise.
test.use({
  baseURL: docsBaseUrl ?? undefined,
  viewport: { width: 1440, height: 900 }
});

// Helpers ────────────────────────────────────────────────────────────

async function authedGoto(page: Page, hash: string): Promise<void> {
  // Stuff the bearer into localStorage before the SPA boots so the
  // very first XHR (`/api/v1/me`) is already authenticated.
  await page.addInitScript((token) => {
    window.localStorage.setItem("sm_token", token);
  }, docsToken!);
  await page.goto(`/#${hash}`);
}

async function capture(page: Page, name: string): Promise<void> {
  // fullPage so a long list (services, builds, registry tags) isn't
  // chopped at viewport height. Disable animations so repeat runs
  // produce byte-identical images when nothing changed.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({
    path: path.join(screenshotsDir, name),
    fullPage: true,
    animations: "disabled"
  });
}

// Captures ───────────────────────────────────────────────────────────

test("dashboard", async ({ page }) => {
  await authedGoto(page, "dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await capture(page, "dashboard.png");
});

test("agents-list", async ({ page }) => {
  await authedGoto(page, "agents");
  await expect(
    page.getByRole("heading", { name: "Connected Agents" })
  ).toBeVisible();
  // Give live presence indicators a moment to settle so the screenshot
  // isn't of a half-loaded list.
  await page.waitForTimeout(1500);
  await capture(page, "agents-list.png");
});

test("services-list", async ({ page }) => {
  await authedGoto(page, "services");
  await expect(
    page.getByRole("heading", { name: "Monitored Services" })
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await capture(page, "services-list.png");
});

test("services-add-form", async ({ page }) => {
  await authedGoto(page, "services");
  await expect(
    page.getByRole("heading", { name: "Monitored Services" })
  ).toBeVisible();
  // Open the create form so we can see every field (including the new
  // Pipeline Name input and the Bound agents fieldset).
  await page.getByRole("button", { name: "Add Service" }).click();
  await expect(page.getByText("Pipeline Name")).toBeVisible();
  await capture(page, "services-add-form.png");
});

test("services-builds-expanded", async ({ page }) => {
  await authedGoto(page, "services");
  await expect(
    page.getByRole("heading", { name: "Monitored Services" })
  ).toBeVisible();
  // Click the first "Builds" button on the services table so the
  // BuildsForServiceSection drops in under that row.
  const buildsBtns = page.getByRole("button", { name: /^Builds$/ });
  await expect(buildsBtns.first()).toBeVisible();
  await buildsBtns.first().click();
  await page.waitForTimeout(1500);
  await capture(page, "services-builds-expanded.png");
});

test("registry-list", async ({ page }) => {
  await authedGoto(page, "registry");
  await expect(page.getByRole("heading", { name: "Registry" })).toBeVisible();
  await page.waitForTimeout(1500);
  await capture(page, "registry-list.png");
});

test("registry-tags-expanded", async ({ page }) => {
  await authedGoto(page, "registry");
  await expect(page.getByRole("heading", { name: "Registry" })).toBeVisible();
  await page.waitForTimeout(1500);
  // Expand the first repository row so the tag table renders.
  const firstRepo = page.locator("button >> strong").first();
  if (await firstRepo.isVisible().catch(() => false)) {
    await firstRepo.click();
    await page.waitForTimeout(1000);
  }
  await capture(page, "registry-tags-expanded.png");
});

test("ssh-keys", async ({ page }) => {
  await authedGoto(page, "sshKeys");
  await expect(page.getByRole("heading", { name: /SSH/i })).toBeVisible();
  await capture(page, "ssh-keys.png");
});

test("load-balancers", async ({ page }) => {
  await authedGoto(page, "loadBalancers");
  await expect(
    page.getByRole("heading", { name: /Load Balancers/i })
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await capture(page, "load-balancers.png");
});
