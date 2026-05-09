/**
 * Real-backend memory probe. Unlike agents-memory.spec.ts (which mocks every
 * HTTP route + WS frame in-process), this test points at a live Kaiad API
 * with a seeded tenant/agent/binding and a fake-agent driver streaming real
 * host_stats + app_stats over the actual /realtime WebSocket → broadcast
 * over the real /api/v1/realtime/ui WebSocket via RealtimeManager.
 *
 * How to run
 *   1. Start postgres on 127.0.0.1:54329 with a `kaiad` database.
 *   2. Boot Kaiad API:
 *        DATABASE_URL=postgres://postgres@127.0.0.1:54329/kaiad \
 *        REDIS_DISABLED=1 PORT=3001 \
 *        node apps/api/dist/server.js
 *   3. Seed t-1 + agent-real + svc-real binding (see harness in this file's
 *      sibling docs / shell history — `INSERT INTO tenants...`).
 *   4. Run a fake-agent driver streaming host_stats/app_stats at ~30 Hz to
 *      ws://127.0.0.1:3001/realtime.
 *   5. BASE_URL=http://127.0.0.1:3001 PW_SKIP_WEBSERVER=1 pnpm exec \
 *        playwright test agents-memory-real-backend.spec.ts
 *
 * The dev-token shortcut (NODE_ENV !== "production") gives us an admin
 * session in tenant t-1, so no login dance is needed.
 */
import { expect, test } from "@playwright/test";

type Sample = {
  label: string;
  jsHeapUsedMB: number;
  jsHeapTotalMB: number;
  domNodes: number;
  jsListeners: number;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sm_token", "dev-token");
  });
});

test("memory snapshot of the AgentsPage with a bound row expanded — REAL backend", async ({
  page
}) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const samples: Sample[] = [];
  const sample = async (label: string) => {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
    samples.push({
      label,
      jsHeapUsedMB: +(get("JSHeapUsedSize") / (1024 * 1024)).toFixed(2),
      jsHeapTotalMB: +(get("JSHeapTotalSize") / (1024 * 1024)).toFixed(2),
      domNodes: get("Nodes"),
      jsListeners: get("JSEventListeners")
    });
  };

  await page.goto("/#agents");
  await expect(page.getByRole("heading", { name: "Connected Agents" })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByText("edge-real")).toBeVisible({ timeout: 10_000 });
  await sample("after-mount, row collapsed");

  await page.getByRole("button", { name: "Expand apps" }).click();
  await expect(page.getByRole("button", { name: "Detach" })).toBeVisible({ timeout: 5_000 });
  await sample("row expanded, t=0");

  // 30 samples at 1 second intervals while the fake agent floods ~30 events
  // per type per second through the real API. 30s is long enough to detect
  // a real leak (linear growth) but short enough to keep the test sane.
  for (let i = 1; i <= 30; i++) {
    await page.waitForTimeout(1000);
    await sample(`row expanded, +${i}s under live WS`);
  }

  const peak = Math.max(...samples.map((s) => s.jsHeapUsedMB));
  const flooded = samples.filter((s) => s.label.startsWith("row expanded, +"));
  const first = flooded[0].jsHeapUsedMB;
  const last = flooded[flooded.length - 1].jsHeapUsedMB;
  const growthPct = ((last - first) / Math.max(first, 0.001)) * 100;

  for (const s of samples) {
    // eslint-disable-next-line no-console
    console.log(
      `[memory-real] ${s.label.padEnd(40)} heap_used=${s.jsHeapUsedMB}MB heap_total=${s.jsHeapTotalMB}MB nodes=${s.domNodes} listeners=${s.jsListeners}`
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[memory-real] peak=${peak}MB; growth across 10s flood: ${first}MB → ${last}MB (${growthPct.toFixed(1)}%)`
  );

  // Soft-bound assertions; not the point of the test, just to flag obvious
  // regressions if the backend wires into something pathological later.
  expect.soft(peak).toBeLessThan(80);
  expect.soft(growthPct).toBeLessThan(200);
});
