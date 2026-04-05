import { expect, test } from "@playwright/test";

const baseUrlSet = Boolean(process.env.BASE_URL?.trim());

test.beforeEach(async ({ page }) => {
  test.skip(
    !baseUrlSet,
    "Set BASE_URL to run browser E2E (e.g. BASE_URL=http://localhost:5173 pnpm e2e:playwright)",
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("sm_token", "dev-token");
  });
});

test("E2E-001 Operator auth smoke", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Kaiad")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

test("E2E-002 Navigation to incidents", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Incidents" }).click();
  await expect(page).toHaveURL(/#incidents/);
  await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
});

test("E2E-003 Agents page renders", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page).toHaveURL(/#agents/);
  await expect(page.getByRole("heading", { name: "Connected Agents" })).toBeVisible();
});

test("E2E-004 Services create form includes Docker fields", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Services" }).click();
  await expect(page).toHaveURL(/#services/);
  await page.getByRole("button", { name: "Add Service" }).click();
  await expect(page.getByLabel("Docker Image (optional)")).toBeVisible();
  await expect(page.getByLabel("Compose Path (optional)")).toBeVisible();
});

test("E2E-005 Workflow editor validates graph", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page).toHaveURL(/#workflows/);
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Workflow graph is valid")).toBeVisible();
});

test("E2E-006 Settings exposes automation kill switch", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/#settings/);
  await expect(page.getByRole("button", { name: "Kill Switch — Disable All Automation" })).toBeVisible();
});
