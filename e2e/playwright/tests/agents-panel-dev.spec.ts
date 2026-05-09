/**
 * Soak test against the deployed dev panel (panel.dev.kaiad.dev).
 *
 *   - No mocks. Hits the real Kaiad API + real /api/v1/realtime/ui WebSocket
 *     fanned out by RealtimeManager from whatever real agents happen to be
 *     connected.
 *   - Opens /#agents, expands every row that has a chevron, then holds the
 *     page open for ~120s, sampling heap / DOM / listener counts every 15s.
 *   - We do NOT assess "issues" until t >= 120s — the request is to give the
 *     page time to settle. Earlier samples are reported but not asserted on.
 *   - At t=120s we soft-assert: peak heap < 80 MB, growth from first to last
 *     sample < 200% (a rough leak signature). These are loose; the point is
 *     to print the numbers, not to fail the test.
 *
 * Run from e2e/playwright with:
 *   BASE_URL=http://panel.dev.kaiad.dev PW_SKIP_WEBSERVER=1 \
 *     pnpm exec playwright test agents-panel-dev --workers=1 --timeout=300000
 */
import { expect, test } from "@playwright/test";

type Sample = {
  tSec: number;
  jsHeapUsedMB: number;
  jsHeapTotalMB: number;
  domNodes: number;
  jsListeners: number;
  longTaskCount: number;
  longTaskMaxMs: number;
};

test.describe.configure({ mode: "serial" });

test("dev-panel /#agents soak: 2-minute hold, sample every 15s", async ({ page }) => {
  test.setTimeout(300_000);

  // Plant the dev-token before any page script runs. The dev container has
  // NODE_ENV=development (or SM_ALLOW_DEV_TOKEN=1), so this short-circuits
  // through DEV_SESSION → tenant t-1 / role owner.
  await page.addInitScript(() => {
    window.localStorage.setItem("sm_token", "dev-token");
  });

  const longTasks: number[] = [];
  await page.exposeFunction("__recordLongTask", (d: number) => longTasks.push(d));
  await page.addInitScript(() => {
    try {
      const obs = new PerformanceObserver((entries) => {
        for (const e of entries.getEntries()) {
          // @ts-ignore
          (window as any).__recordLongTask(e.duration);
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask not supported in this build */
    }
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const samples: Sample[] = [];
  let startMs = 0;

  async function sample(): Promise<Sample> {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
    const longTaskMaxMs = longTasks.length > 0 ? Math.max(...longTasks) : 0;
    const s: Sample = {
      tSec: Math.round((Date.now() - startMs) / 1000),
      jsHeapUsedMB: +(get("JSHeapUsedSize") / (1024 * 1024)).toFixed(2),
      jsHeapTotalMB: +(get("JSHeapTotalSize") / (1024 * 1024)).toFixed(2),
      domNodes: get("Nodes"),
      jsListeners: get("JSEventListeners"),
      longTaskCount: longTasks.length,
      longTaskMaxMs: Math.round(longTaskMaxMs)
    };
    samples.push(s);
    // eslint-disable-next-line no-console
    console.log(
      `[soak t+${String(s.tSec).padStart(3, " ")}s]` +
        ` heap_used=${s.jsHeapUsedMB}MB heap_total=${s.jsHeapTotalMB}MB` +
        ` nodes=${s.domNodes} listeners=${s.jsListeners}` +
        ` longtasks=${s.longTaskCount} (max=${s.longTaskMaxMs}ms)`
    );
    return s;
  }

  await page.goto("/#agents", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Connected Agents" })).toBeVisible({
    timeout: 20_000
  });

  // Try to expand every row that has an expand chevron, so the heavy
  // expanded-row code paths (AppsTelemetryTable + ServicesForAgentSection +
  // ErrorGroupsSection) are mounted during the soak.
  const expandButtons = page.getByRole("button", { name: "Expand apps" });
  const expandCount = await expandButtons.count();
  for (let i = 0; i < expandCount; i++) {
    await expandButtons.nth(i).click().catch(() => undefined);
  }
  // eslint-disable-next-line no-console
  console.log(`[soak] expanded ${expandCount} agent row(s)`);

  startMs = Date.now();
  await sample(); // t=0

  // Sample every 15s for 120s total → 8 samples after t=0.
  for (let i = 1; i <= 8; i++) {
    await page.waitForTimeout(15_000);
    await sample();
  }

  // Per request: do not assess until t >= 120s. Use the t>=120s sample.
  const finalSample = samples[samples.length - 1];
  const firstSample = samples[1] ?? samples[0]; // first post-mount sample
  const growthPct =
    ((finalSample.jsHeapUsedMB - firstSample.jsHeapUsedMB) / Math.max(firstSample.jsHeapUsedMB, 0.001)) * 100;
  const peak = Math.max(...samples.map((s) => s.jsHeapUsedMB));
  const peakNodes = Math.max(...samples.map((s) => s.domNodes));

  // eslint-disable-next-line no-console
  console.log(
    `[soak summary] tFinal=${finalSample.tSec}s heap=${finalSample.jsHeapUsedMB}MB` +
      ` peak=${peak}MB peakNodes=${peakNodes} listeners=${finalSample.jsListeners}` +
      ` growth(t15→tFinal)=${growthPct.toFixed(1)}% longtasks=${finalSample.longTaskCount} maxLong=${finalSample.longTaskMaxMs}ms`
  );

  expect.soft(peak).toBeLessThan(80);
  expect.soft(growthPct).toBeLessThan(200);
  expect.soft(finalSample.longTaskMaxMs).toBeLessThan(2000);
});
