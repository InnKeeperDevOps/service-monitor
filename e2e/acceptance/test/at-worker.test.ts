import { beforeAll, describe, expect, it } from "vitest";

const workerBase = process.env.WORKER_BASE ?? "http://localhost:9090";

/** Poll until worker health is reachable (CI docker compose --wait, or local stack). */
async function waitForWorkerHealth(base: string, maxMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${base}/health (last error: ${String(lastErr)})`);
}

describe("AT worker suite", () => {
  beforeAll(async () => {
    await waitForWorkerHealth(workerBase);
  }, 130_000);

  it("AT-WKR-001 GET worker health returns 200 when worker service is running", async () => {
    const response = await fetch(`${workerBase}/health`);
    expect(response.status).toBe(200);
  });
});
