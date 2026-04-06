import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/me", (route) => {
    if (route.request().method() !== "GET") {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "u-e2e",
        email: "e2e@example.com",
        role: "admin",
        tenantId: "t-1"
      })
    });
  });
  await page.route("**/api/v1/setup/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ setupRequired: false, version: "0.1.0" })
    })
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("sm_token", "dev-token");
  });
});

test("E2E-001 Operator auth smoke", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Kaiad")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
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

test("E2E-005 Workflow editor graph actions and trigger params", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page).toHaveURL(/#workflows/);
  await page.getByText("onCrash").first().click();
  await expect(page.getByRole("button", { name: "Disconnect node" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete node" })).toBeVisible();
  await expect(page.getByLabel("Schedule (cron)")).toHaveCount(0);
  await page.getByLabel("Node type").selectOption("onSchedule");
  await expect(page.getByLabel("Schedule (cron)")).toBeVisible();
  await page.getByLabel("Node type").selectOption("onCrash");
  await expect(page.getByLabel("Schedule (cron)")).toHaveCount(0);
  await page.getByRole("button", { name: "Disconnect node" }).click();
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByText("Validation errors:")).toBeVisible();
});

test("E2E-006 Settings exposes automation kill switch", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/#settings/);
  await expect(page.getByRole("button", { name: "Kill Switch — Disable All Automation" })).toBeVisible();
});
