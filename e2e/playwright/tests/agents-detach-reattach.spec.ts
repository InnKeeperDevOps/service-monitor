/**
 * Repro: open the agents page, expand the kagent row, then loop
 * Bind ↔ Detach the springboot-test-server service while sampling
 * browser memory. Goal is to see whether the documented
 * memory issue manifests under the detach / re-attach interaction.
 *
 * Run with:
 *   BASE_URL=https://panel.dev.kaiad.dev PW_SKIP_WEBSERVER=1 \
 *     pnpm exec playwright test agents-detach-reattach \
 *       --workers=1 --timeout=900000
 */
import { expect, test } from "@playwright/test";

const KAGENT_PREFIX = "kagent-";
const SERVICE_NAME = "springboot-test-server";
const CYCLES = Number(process.env.CYCLES ?? 30);

type Sample = {
  cycle: number;
  phase: string;
  jsHeapUsedMB: number;
  jsHeapTotalMB: number;
  domNodes: number;
  jsListeners: number;
  longTaskCount: number;
  longTaskMaxMs: number;
};

test("detach/re-attach cycle on kagent row", async ({ page }) => {
  test.setTimeout(900_000);

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
  async function sample(cycle: number, phase: string) {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
    const longTaskMaxMs = longTasks.length > 0 ? Math.max(...longTasks) : 0;
    const s: Sample = {
      cycle,
      phase,
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
      `[c${String(cycle).padStart(2, "0")} ${phase.padEnd(8)}] heap=${s.jsHeapUsedMB}MB ` +
        `total=${s.jsHeapTotalMB}MB nodes=${s.domNodes} listeners=${s.jsListeners} ` +
        `longtasks=${s.longTaskCount} (max=${s.longTaskMaxMs}ms)`
    );
  }

  // Page open + agents page
  await page.goto("/#agents", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Connected Agents" })).toBeVisible({
    timeout: 20_000
  });
  // wait for the kagent row to render (live agent)
  await expect(page.getByText(new RegExp(`^${KAGENT_PREFIX}`))).toBeVisible({ timeout: 15_000 });

  // The Vue panel renders multiple "Expand apps" buttons — one per agent
  // row. Find the chevron in the row that contains the kagent id text.
  const kagentRow = page
    .locator("tr")
    .filter({ has: page.getByText(new RegExp(`^${KAGENT_PREFIX}`)) })
    .first();
  await kagentRow.getByRole("button", { name: "Expand apps" }).click();

  // The expanded row sits as the next <tr>. Wait for the bind picker
  // (specific to ServicesForAgentSection) to appear. The picker exists
  // for both kagent and agent-local rows if both are expanded; we only
  // expanded kagent's row.
  const picker = page.getByRole("combobox", {
    name: "Pick a service to bind to this agent"
  });
  await expect(picker).toBeVisible({ timeout: 10_000 });

  await sample(0, "init");

  for (let c = 1; c <= CYCLES; c++) {
    // BIND springboot-test-server to kagent
    await picker.selectOption({ label: SERVICE_NAME });
    await page.getByRole("button", { name: "+ Bind" }).click();
    // Wait for the bound list item to appear (the same name appears as a
    // listitem inside the role=list once bound).
    await expect(
      page.getByRole("listitem").filter({ hasText: SERVICE_NAME })
    ).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await sample(c, "bound");

    // DETACH it again
    const detachBtn = page
      .getByRole("listitem")
      .filter({ hasText: SERVICE_NAME })
      .getByRole("button", { name: "Detach" });
    await detachBtn.click();
    await expect(
      page.getByRole("listitem").filter({ hasText: SERVICE_NAME })
    ).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(500);
    await sample(c, "detached");
  }

  // Final summary
  const init = samples[0];
  const last = samples[samples.length - 1];
  const peak = samples.reduce((a, b) => (a.jsHeapUsedMB > b.jsHeapUsedMB ? a : b));
  const growth = ((last.jsHeapUsedMB - init.jsHeapUsedMB) / Math.max(init.jsHeapUsedMB, 0.001)) * 100;
  // eslint-disable-next-line no-console
  console.log(
    `[summary] cycles=${CYCLES} init_heap=${init.jsHeapUsedMB}MB ` +
      `final_heap=${last.jsHeapUsedMB}MB peak=${peak.jsHeapUsedMB}MB(@c${peak.cycle}/${peak.phase}) ` +
      `growth=${growth.toFixed(1)}% nodes ${init.domNodes}→${last.domNodes} ` +
      `listeners ${init.jsListeners}→${last.jsListeners} longtasks=${last.longTaskCount} ` +
      `maxLong=${last.longTaskMaxMs}ms`
  );
});
