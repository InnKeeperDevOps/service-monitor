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

  it(
    "AT-RT-002 full agent lifecycle: register, receive per-step run_step commands, ack each, disconnect",
    async () => {
      const internalToken = process.env.INTERNAL_API_TOKEN ?? "dev-token";
      const agentId = `at-rt-002-${Date.now()}`;
      const wsUrl = `${httpToWsBase(apiBase)}/realtime`;
      const ws = new WebSocket(wsUrl);

      // Every frame the server sends is appended here so we can assert the full sequence.
      const frames: any[] = [];
      const pendingMatchers: Array<(parsed: any) => boolean> = [];

      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        frames.push(parsed);
        for (let i = pendingMatchers.length - 1; i >= 0; i--) {
          if (pendingMatchers[i](parsed)) pendingMatchers.splice(i, 1);
        }
      });
      ws.on("error", () => {
        /* surfaced via timeouts below */
      });

      function waitFor(predicate: (parsed: any) => boolean, timeoutMs = 15_000): Promise<any> {
        for (const frame of frames) {
          if (predicate(frame)) return Promise.resolve(frame);
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = pendingMatchers.indexOf(matcher);
            if (idx !== -1) pendingMatchers.splice(idx, 1);
            reject(
              new Error(
                `AT-RT-002 waitFor timed out after ${timeoutMs}ms. Frames (${frames.length}): ${JSON.stringify(frames)}`
              )
            );
          }, timeoutMs);
          const matcher = (parsed: any) => {
            if (predicate(parsed)) {
              clearTimeout(timer);
              resolve(parsed);
              return true;
            }
            return false;
          };
          pendingMatchers.push(matcher);
        });
      }

      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });

        const hello = await waitFor((f) => f.type === "hello");
        expect(hello.service).toBe("realtime");

        // Register the agent via a heartbeat.
        ws.send(
          JSON.stringify({
            type: "heartbeat",
            agentId,
            ts: new Date().toISOString(),
            capacity: 4,
            tenantId: "t-1"
          })
        );
        await waitFor((f) => f.type === "ack" && f.accepted === true);

        // Dispatch a 3-step workflow (each step is a distinct run_step command).
        const steps = [
          { commandId: `${agentId}-step-1`, shell: "echo step-1" },
          { commandId: `${agentId}-step-2`, shell: "echo step-2" },
          { commandId: `${agentId}-step-3`, shell: "echo step-3" }
        ];

        for (const step of steps) {
          const dispatchRes = await fetch(`${apiBase}/api/v1/internal/agent-commands`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${internalToken}`
            },
            body: JSON.stringify({
              agentId,
              commandId: step.commandId,
              payload: { type: "run_step", shell: step.shell, env: {} }
            })
          });
          expect(dispatchRes.status).toBe(202);
          const body = (await dispatchRes.json()) as {
            accepted: true;
            commandId: string;
            delivered: boolean;
          };
          expect(body).toEqual(
            expect.objectContaining({
              accepted: true,
              commandId: step.commandId,
              delivered: true
            })
          );

          const delivered = await waitFor(
            (f) => f.type === "run_step" && f.commandId === step.commandId
          );
          expect(delivered.shell).toBe(step.shell);

          ws.send(
            JSON.stringify({
              type: "command_ack",
              commandId: step.commandId,
              status: "completed",
              ts: new Date().toISOString(),
              output: `ok:${step.commandId}`
            })
          );
          await waitFor((f) => f.type === "ack" && f.accepted === true);
        }

        // Sanity: every run_step should have been delivered in dispatch order.
        const runStepIds = frames.filter((f) => f.type === "run_step").map((f) => f.commandId);
        expect(runStepIds).toEqual(steps.map((s) => s.commandId));
      } finally {
        ws.close();
        await new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.once("close", () => resolve());
        });
      }
    },
    60_000
  );
});
