/**
 * Long soak against the live dev panel. Keeps the agents page open for
 * SOAK_SEC seconds (default 900s = 15min), sampling browser-side heap /
 * DOM / listeners every 30s. Designed to catch slow drift the 2-min
 * smoke could miss.
 *
 * Run from e2e/playwright with:
 *   BASE_URL=https://panel.dev.kaiad.dev PW_SKIP_WEBSERVER=1 \
 *     pnpm exec playwright test agents-panel-dev-long --workers=1 \
 *     --timeout=1200000
 */
import { expect, test } from "@playwright/test";

const SOAK_SEC = Number(process.env.SOAK_SEC ?? 900);

type Sample = {
  tSec: number;
  jsHeapUsedMB: number;
  jsHeapTotalMB: number;
  domNodes: number;
  jsListeners: number;
  longTaskCount: number;
  longTaskMaxMs: number;
};

test("dev-panel long soak", async ({ page }) => {
  test.setTimeout((SOAK_SEC + 120) * 1000);

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
      /* longtask not supported */
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
      `[soak t+${String(s.tSec).padStart(4, " ")}s]` +
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

  const expandButtons = page.getByRole("button", { name: "Expand apps" });
  const expandCount = await expandButtons.count();
  for (let i = 0; i < expandCount; i++) {
    await expandButtons.nth(i).click().catch(() => undefined);
  }
  // eslint-disable-next-line no-console
  console.log(`[soak] expanded ${expandCount} agent row(s); soaking for ${SOAK_SEC}s`);

  startMs = Date.now();
  await sample(); // t=0
  const intervalMs = 30_000;
  const totalSamples = Math.floor(SOAK_SEC / 30);
  for (let i = 1; i <= totalSamples; i++) {
    await page.waitForTimeout(intervalMs);
    await sample();
  }

  const peak = Math.max(...samples.map((s) => s.jsHeapUsedMB));
  const first = samples[1] ?? samples[0];
  const last = samples[samples.length - 1];
  const growthPct = ((last.jsHeapUsedMB - first.jsHeapUsedMB) / Math.max(first.jsHeapUsedMB, 0.001)) * 100;

  // eslint-disable-next-line no-console
  console.log(
    `[soak summary] tFinal=${last.tSec}s heap=${last.jsHeapUsedMB}MB peak=${peak}MB nodes=${last.domNodes}` +
      ` listeners=${last.jsListeners} growth(t30→tFinal)=${growthPct.toFixed(1)}% longtasks=${last.longTaskCount} maxLong=${last.longTaskMaxMs}ms`
  );

  // No hard expect.* — we want the data, not a pass/fail.
});
