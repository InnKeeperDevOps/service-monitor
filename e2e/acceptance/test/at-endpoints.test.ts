import { beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const acceptanceEnabled = process.env.RUN_ACCEPTANCE === "1";
const describeAcceptance = acceptanceEnabled ? describe : describe.skip;
const apiBase = process.env.API_BASE ?? "http://localhost:3001";

function httpToWsBase(base: string): string {
  if (base.startsWith("https://")) {
    return `wss://${base.slice("https://".length)}`;
  }
  return `ws://${base.replace(/^http:\/\//, "")}`;
}

/** Poll until the stack is reachable (CI docker compose --wait, or local dev server). */
async function waitForReady(base: string, maxMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/ready`);
      if (response.ok) {
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${base}/ready (last error: ${String(lastErr)})`);
}

describeAcceptance("AT endpoint suite", () => {
  beforeAll(async () => {
    await waitForReady(apiBase);
  }, 130_000);

  it("AT-API-001 health", async () => {
    const response = await fetch(`${apiBase}/health`);
    expect(response.status).toBe(200);
  });

  it("AT-API-002 ready", async () => {
    const response = await fetch(`${apiBase}/ready`);
    expect(response.status).toBe(200);
  });

  it("AT-API-003 authenticated me", async () => {
    const response = await fetch(`${apiBase}/api/v1/me`, {
      headers: { authorization: "Bearer dev-token" }
    });
    expect(response.status).toBe(200);
  });

  it("AT-API-004 GitHub webhook rejects invalid signature", async () => {
    const body = JSON.stringify({ action: "ping" });
    const response = await fetch(`${apiBase}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000"
      },
      body
    });
    expect([401, 403]).toContain(response.status);
  });

  it("AT-RT-001 realtime websocket hello", async () => {
    const url = `${httpToWsBase(apiBase)}/realtime`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for first WebSocket frame"));
      }, 15_000);

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.once("message", (data) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data.toString()) as { type?: string };
          expect(parsed.type).toBe("hello");
          ws.close();
          resolve();
        } catch (err) {
          ws.close();
          reject(err);
        }
      });
    });
  });
});
