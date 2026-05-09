/**
 * Memory probe for the Agents page. Loads the page with one online agent and
 * one bound service, expands the row, then samples Chrome's heap via CDP at
 * intervals while a moderate WebSocket telemetry stream is active. Reports
 * the numbers as test annotations and asserts soft growth bounds.
 *
 * What it answers
 *   - How much JS heap does the AgentsPage consume on mount?
 *   - Does the heap grow without bound while host_stats events stream in
 *     and the bound row stays mounted? (Suggests an unbounded accumulator,
 *     e.g. `live.errorGroups` which is never pruned by useTelemetryStream.)
 *   - How many DOM nodes does the expanded row produce?
 */
import { expect, test } from "@playwright/test";

const TENANT_ID = "t1";
const AGENT_ID = "agent-mem";
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

  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "u-e2e",
        email: "e2e@example.com",
        role: "admin",
        tenantId: TENANT_ID
      })
    })
  );

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

  await page.route(`**/api/v1/agents/${AGENT_ID}/error-groups`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ groups: [] })
    })
  );

  await page.route("**/api/v1/agents/enrollment-tokens", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tokens: [] })
    });
  });
});

type Sample = {
  label: string;
  jsHeapUsedMB: number;
  jsHeapTotalMB: number;
  domNodes: number;
  jsListeners: number;
};

test("memory snapshot of the AgentsPage with a bound row expanded", async ({ page }) => {
  // Hold the WS open without traffic — establishes a baseline footprint
  // that's purely due to mount + initial fetch.
  await page.routeWebSocket("**/api/v1/realtime/ui*", () => {
    /* idle */
  });

  // CDP session for accurate heap & DOM metrics. Performance.getMetrics
  // returns counters Chromium tracks internally; more reliable than
  // performance.memory (which is gated and coarse).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const samples: Sample[] = [];
  const sample = async (label: string) => {
    // Force a GC before reading so the numbers reflect retained, not
    // garbage-pending, memory.
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
    timeout: 10_000
  });
  await expect(page.getByText("edge-1")).toBeVisible({ timeout: 10_000 });
  await sample("after-mount, row collapsed");

  await page.getByRole("button", { name: "Expand apps" }).click();
  await expect(page.getByRole("button", { name: "Detach" })).toBeVisible({ timeout: 5_000 });
  await sample("row expanded, no WS traffic");

  // Now flood the WS for 5 seconds while the bound row is mounted, sampling
  // every second. Watching for steady-state growth.
  let stop = false;
  const flood = (async () => {
    const ws = await page.context().request; // not used; flooding via routeWebSocket
    void ws;
  })();
  void flood;

  // Re-route the WS with a flood for the rest of the test. (We re-route
  // mid-test so the baseline samples were captured against the silent peer.)
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // Re-install just the routes we still need (HTTP). Page already has data
  // loaded, but the 30s poll will fire.
  await page.route("**/api/v1/agents", (route) =>
    route.fulfill({
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
    })
  );
  await page.route("**/api/v1/services", (route) =>
    route.fulfill({
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
    })
  );

  await page.routeWebSocket("**/api/v1/realtime/ui*", (server) => {
    let stopped = false;
    const interval = setInterval(() => {
      if (stopped || stop) return;
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
    }, 50); // ~20 of each event per second

    server.onClose(() => {
      stopped = true;
      clearInterval(interval);
    });
  });

  // Force the page to reconnect to the new WS route. Easiest: reload the
  // hash so the existing socket closes and a new one is opened against the
  // flood handler.
  await page.evaluate(() => {
    // The existing telemetry socket is private, but reloading reuses cached
    // chunks and reattaches mounts. This is the cleanest reset.
    location.reload();
  });
  await expect(page.getByRole("heading", { name: "Connected Agents" })).toBeVisible({
    timeout: 10_000
  });
  await expect(page.getByText("edge-1")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Expand apps" }).click();
  await expect(page.getByRole("button", { name: "Detach" })).toBeVisible({ timeout: 5_000 });

  for (let i = 1; i <= 5; i++) {
    await page.waitForTimeout(1000);
    await sample(`row expanded, +${i}s WS flood`);
  }

  stop = true;
  await page.waitForTimeout(500);
  await sample("after WS flood stopped");

  // Pretty-print the samples.
  for (const s of samples) {
    test.info().annotations.push({
      type: "memory",
      description: `${s.label.padEnd(36)} heap_used=${s.jsHeapUsedMB}MB heap_total=${s.jsHeapTotalMB}MB nodes=${s.domNodes} listeners=${s.jsListeners}`
    });
    // Also log to stderr so the reporter line shows them inline.
    // eslint-disable-next-line no-console
    console.log(
      `[memory] ${s.label.padEnd(36)} heap_used=${s.jsHeapUsedMB}MB heap_total=${s.jsHeapTotalMB}MB nodes=${s.domNodes} listeners=${s.jsListeners}`
    );
  }

  // Soft-bound assertions to flag genuine leaks. The page is small;
  // 50 MB is generous.
  const peak = Math.max(...samples.map((s) => s.jsHeapUsedMB));
  expect.soft(peak).toBeLessThan(50);

  // Check for monotonic growth across the WS-flood samples — a clear leak
  // signature is "+1s < +2s < +3s < +4s < +5s" with a >50% delta.
  const flooded = samples.filter((s) => s.label.startsWith("row expanded, +"));
  if (flooded.length >= 2) {
    const first = flooded[0].jsHeapUsedMB;
    const last = flooded[flooded.length - 1].jsHeapUsedMB;
    const growthPct = ((last - first) / Math.max(first, 0.001)) * 100;
    test.info().annotations.push({
      type: "memory-growth",
      description: `during 5s WS flood: ${first}MB → ${last}MB (${growthPct.toFixed(1)}%)`
    });
    // eslint-disable-next-line no-console
    console.log(
      `[memory] during 5s WS flood: ${first}MB → ${last}MB (${growthPct.toFixed(1)}%)`
    );
    // > 200% growth in 5 seconds is a leak signature.
    expect.soft(growthPct).toBeLessThan(200);
  }
});
