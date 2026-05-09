/**
 * Reproduces (or refutes) the Chrome lock-up that triggered commit 17a2f1f
 * ("revert(web): gate ServicesForAgentSection off — Chrome lock-up under
 * bindings"). The working tree re-enables the section + rewrites the bound
 * list from a nested <table> to flex <div>s. This spec checks whether
 * expanding an agent row that has bound services keeps the page responsive.
 *
 * Strategy
 *   - Mock /api/v1/agents with one online agent.
 *   - Mock /api/v1/services with a service that has agents[] bound to it
 *     (so ServicesForAgentSection renders its non-empty branch).
 *   - Mock the realtime WebSocket so useTelemetryStream connects but emits
 *     no events (we want to isolate render cost, not event-driven thrash).
 *   - Expand the agent row, then drive a tight responsiveness probe: wait
 *     for the bound service name to render, and run page.evaluate() with a
 *     short timeout. If Chrome locks up, the evaluate call won't return.
 *   - As a stronger probe, do a series of rapid clicks (collapse/expand) and
 *     measure that each round-trips inside a budget.
 */
import { expect, test } from "@playwright/test";

const TENANT_ID = "t1";
const AGENT_ID = "agent-lockup";
const SERVICE_ID = "svc-bound";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sm_token", "dev-token");
  });

  await page.route("**/api/v1/setup/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ setupRequired: false, version: "0.1.0" })
    })
  );

  await page.route("**/api/v1/me", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "u-e2e",
        email: "e2e@example.com",
        role: "admin",
        tenantId: TENANT_ID
      })
    });
  });

  await page.route("**/api/v1/agents", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agents: [
          {
            id: AGENT_ID,
            tenantId: TENANT_ID,
            name: "edge-1",
            version: "2.1.0",
            status: "online",
            lastSeenAt: new Date().toISOString(),
            allowedCapabilities: [],
            websocketConnected: true
          }
        ]
      })
    });
  });

  await page.route("**/api/v1/services", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        services: [
          {
            id: SERVICE_ID,
            tenantId: TENANT_ID,
            name: "bound-app",
            gitRepoUrl: "git@example.com:o/r.git",
            branch: "main",
            agents: [{ agentId: AGENT_ID }],
            dockerImage: null,
            composePath: null
          }
        ]
      })
    });
  });

  // ErrorGroupsSection fetches per agent on expand — return empty.
  await page.route(`**/api/v1/agents/${AGENT_ID}/error-groups`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ groups: [] })
    })
  );

  // EnrollmentTokensPanel fetches list on mount.
  await page.route("**/api/v1/agents/enrollment-tokens", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tokens: [] })
    });
  });

  // Stub the realtime WebSocket so useTelemetryStream gets a "connected"
  // peer that never emits events. This isolates render-time lock-ups
  // from event-driven thrash.
  await page.routeWebSocket("**/api/v1/realtime/ui*", () => {
    /* hold the socket open silently */
  });
});

// Spec B: explicitly tests the hypothesis from the revert commit message
// ("possibly something downstream of the useMemo recomputing on every
// host_stats event"). We override the WS mock to flood ~60 host_stats and
// app_stats events per second, with the expanded row mounted, and probe
// responsiveness.
test.describe("under heavy host_stats traffic", () => {
  test.beforeEach(async ({ page }) => {
    // Re-route the WS to actively emit a high-volume telemetry stream once a
    // client connects. We send ~30 host_stats + 30 app_stats per second for
    // 5 seconds, while the row is being expanded by the test body.
    await page.routeWebSocket("**/api/v1/realtime/ui*", (server) => {
      let stopped = false;
      const interval = setInterval(() => {
        if (stopped) return;
        // host_stats — drives useTelemetryStream.applyEvent, which always
        // produces a new state object → AgentsPage re-renders → every
        // expanded ServicesForAgentSection re-renders.
        server.send(
          JSON.stringify({
            type: "host_stats",
            agentId: AGENT_ID,
            stats: {
              ts: new Date().toISOString(),
              cpuPercent: Math.random() * 100,
              memUsedBytes: 1_000_000_000,
              memTotalBytes: 8_000_000_000,
              memPercent: 12.5,
              diskUsedBytes: 50_000_000_000,
              diskTotalBytes: 200_000_000_000,
              diskPath: "/",
              netRxBytesPerSec: Math.random() * 100_000,
              netTxBytesPerSec: Math.random() * 100_000,
              processRSSBytes: 100_000_000
            }
          })
        );
        server.send(
          JSON.stringify({
            type: "app_stats",
            agentId: AGENT_ID,
            containerId: "c-1",
            stats: {
              ts: new Date().toISOString(),
              name: "app-1",
              image: "ghcr.io/o/app:latest",
              state: "running",
              cpuPercent: Math.random() * 100,
              memUsedBytes: 200_000_000,
              memLimitBytes: 1_000_000_000,
              memPercent: 20,
              netRxBytesPerSec: Math.random() * 10_000,
              netTxBytesPerSec: Math.random() * 10_000
            }
          })
        );
      }, 33); // ~30 events per type per second

      server.onClose(() => {
        stopped = true;
        clearInterval(interval);
      });
    });
  });

  test("BUG-AGT-LOCKUP-WS: page stays responsive while WS floods host_stats and the bound row is expanded", async ({
    page
  }) => {
    await page.goto("/#agents");
    await expect(page.getByRole("heading", { name: "Connected Agents" })).toBeVisible({
      timeout: 10_000
    });
    await expect(page.getByText("edge-1")).toBeVisible({ timeout: 10_000 });

    // Expand the row so ServicesForAgentSection mounts during the flood.
    await page.getByRole("button", { name: "Expand apps" }).click();
    await expect(page.getByRole("button", { name: "Detach" })).toBeVisible({ timeout: 5_000 });

    // Let the WS pump for a few seconds with the row mounted.
    await page.waitForTimeout(3_000);

    // Probe: 5 rAF round-trips. Under a runaway loop / blocked main thread,
    // these will not return inside the budget.
    const rtts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
      rtts.push(Date.now() - t0);
    }
    test.info().annotations.push({
      type: "rAF-rtt-during-flood",
      description: rtts.map((r) => `${r}ms`).join(", ")
    });
    const maxRtt = Math.max(...rtts);
    expect(maxRtt).toBeLessThan(2000); // hard fail: > 2s = stuck

    // Confirm the bound row is still in the DOM and the page didn't bail
    // out (e.g. crashed renderer).
    await expect(page.getByRole("button", { name: "Detach" })).toBeVisible({ timeout: 2_000 });
  });
});

test("BUG-AGT-LOCKUP: expanding an agent row with bound services keeps the page responsive", async ({
  page
}) => {
  const longTaskMs: number[] = [];
  await page.exposeFunction("recordLongTask", (duration: number) => {
    longTaskMs.push(duration);
  });
  await page.addInitScript(() => {
    try {
      const obs = new PerformanceObserver((entries) => {
        for (const e of entries.getEntries()) {
          // anything > 50ms is a "long task" by spec; we care about huge ones.
          // @ts-ignore
          (window as any).recordLongTask(e.duration);
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask not supported — fine, we still have the eval-budget probe.
    }
  });

  await page.goto("/#agents");

  // Diagnostics: dump body text if the heading doesn't appear so we can tell
  // whether routing/auth is blocking us vs. a real lock-up.
  const heading = page.getByRole("heading", { name: "Connected Agents" });
  try {
    await heading.waitFor({ state: "attached", timeout: 10_000 });
  } catch {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
    const url = page.url();
    throw new Error(`Connected Agents heading never attached. url=${url} body="${bodyText}"`);
  }

  // Wait for the agent row to materialize.
  await expect(page.getByText("edge-1")).toBeVisible({ timeout: 10_000 });

  // Probe 1: synchronous JS round-trip while the row is collapsed.
  // Establishes the baseline budget; if even this is slow, our environment
  // is the problem, not the component.
  const baselineStart = Date.now();
  await page.evaluate(() => 1 + 1);
  const baselineMs = Date.now() - baselineStart;
  test.info().annotations.push({ type: "baseline-eval-ms", description: String(baselineMs) });

  // Expand the row.
  await page.getByRole("button", { name: "Expand apps" }).click();

  // Bound service should render. Use the Detach button as a stable
  // version-agnostic marker — both the original <table> rendering and
  // the new flex-row rendering render this button per bound service.
  // If the page is locked up the page.evaluate probes below will hang.
  await expect(page.getByRole("button", { name: "Detach" })).toBeVisible({ timeout: 5_000 });

  // Probe 2: round-trip eval while the section is rendered. If the main
  // thread is jammed by a runaway loop, this will not return inside the
  // budget — Playwright's evaluate() is queued behind any pending JS.
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const rtt = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          requestAnimationFrame(() => resolve(performance.now()));
        })
    );
    const dt = Date.now() - t0;
    expect.soft(dt).toBeLessThan(1500); // generous: > 1.5s round-trip = stuck
    test.info().annotations.push({ type: `rAF-rtt-${i}`, description: `${dt}ms (${rtt})` });
  }

  // Probe 3: rapid collapse/expand toggles. If a render path is N^2 in
  // bindings or causes layout thrash, this loop will explode.
  for (let i = 0; i < 6; i++) {
    const collapseBtn = page.getByRole("button", { name: "Collapse apps" });
    await collapseBtn.click({ timeout: 2_000 });
    await page.getByRole("button", { name: "Expand apps" }).click({ timeout: 2_000 });
  }

  // After all the toggling, the bound row must still be responsive.
  await expect(page.getByRole("button", { name: "Detach" })).toBeVisible({ timeout: 5_000 });

  // Report longtask stats so we can see if the section is causing
  // frame-blocking work even when it doesn't outright lock up.
  await page.waitForTimeout(500); // give the longtask observer a beat to flush
  const maxLongTask = longTaskMs.length > 0 ? Math.max(...longTaskMs) : 0;
  const totalLongTaskMs = longTaskMs.reduce((a, b) => a + b, 0);
  test.info().annotations.push({
    type: "longtasks",
    description: `count=${longTaskMs.length} max=${Math.round(maxLongTask)}ms total=${Math.round(
      totalLongTaskMs
    )}ms`
  });

  // A single longtask longer than 2 seconds is a smoking gun for the
  // original lock-up symptom.
  expect.soft(maxLongTask).toBeLessThan(2000);
});
