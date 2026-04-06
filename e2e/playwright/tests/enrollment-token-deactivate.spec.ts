import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sm_token", "dev-token");
  });
});

/**
 * Enrollment deactivation uses window.confirm. Playwright auto-dismisses native dialogs
 * in a way that makes confirm() return false, so the deactivate API is never called unless
 * the test accepts the dialog explicitly.
 */
test("E2E-007 Enrollment token deactivate: confirm dialog and POST /deactivate", async ({ page }) => {
  const tokenId = "tok-e2e-deactivate";
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const created = new Date(Date.now() - 120_000).toISOString();

  let deactivateRequestUrl: string | null = null;

  await page.route("**/api/v1/agents/enrollment-tokens**", async (route) => {
    const req = route.request();
    const method = req.method();
    const pathname = new URL(req.url()).pathname;

    if (method === "GET" && pathname.endsWith("/agents/enrollment-tokens")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tokens: [
            {
              id: tokenId,
              tenantId: "t-1",
              expiresAt: future,
              createdBy: "e2e",
              createdAt: created,
              usedAt: null,
              revokedAt: null,
              isActive: true
            }
          ]
        })
      });
    }

    if (method === "POST" && pathname.endsWith(`/agents/enrollment-tokens/${tokenId}/deactivate`)) {
      deactivateRequestUrl = req.url();
      return route.fulfill({ status: 204 });
    }

    return route.continue();
  });

  await page.goto("/#settings");

  await expect(page.getByRole("heading", { name: "Enrollment Tokens" })).toBeVisible();

  const row = page.locator("tr", { hasText: `${tokenId.slice(0, 12)}...` });
  await expect(row).toContainText("Active");

  page.once("dialog", (dialog) => {
    expect(dialog.type()).toBe("confirm");
    void dialog.accept();
  });

  await page.getByRole("button", { name: `Deactivate token ${tokenId}` }).click();

  await expect.poll(() => deactivateRequestUrl).not.toBeNull();
  expect(deactivateRequestUrl!).toContain(`/enrollment-tokens/${tokenId}/deactivate`);

  await expect(row).toContainText("Revoked");
});

test("E2E-008 Enrollment token deactivate: canceling confirm does not call API", async ({ page }) => {
  const tokenId = "tok-e2e-cancel";
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const created = new Date(Date.now() - 120_000).toISOString();

  let deactivateCalled = false;

  await page.route("**/api/v1/agents/enrollment-tokens**", async (route) => {
    const req = route.request();
    const method = req.method();
    const pathname = new URL(req.url()).pathname;

    if (method === "GET" && pathname.endsWith("/agents/enrollment-tokens")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tokens: [
            {
              id: tokenId,
              tenantId: "t-1",
              expiresAt: future,
              createdBy: "e2e",
              createdAt: created,
              usedAt: null,
              revokedAt: null,
              isActive: true
            }
          ]
        })
      });
    }

    if (method === "POST" && pathname.includes("/deactivate")) {
      deactivateCalled = true;
      return route.fulfill({ status: 204 });
    }

    return route.continue();
  });

  await page.goto("/#settings");
  await expect(page.getByRole("heading", { name: "Enrollment Tokens" })).toBeVisible();

  page.once("dialog", (dialog) => {
    void dialog.dismiss();
  });

  await page.getByRole("button", { name: `Deactivate token ${tokenId}` }).click();

  expect(deactivateCalled).toBe(false);
  await expect(page.locator("tr", { hasText: `${tokenId.slice(0, 12)}...` })).toContainText("Active");
});
