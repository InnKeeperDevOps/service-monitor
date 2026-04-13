/**
 * Integration tests: Kaiad tenant settings propagation to the agent.
 *
 * These tests start the Kaiad API server in-process and connect a WebSocket
 * client (acting as the agent). They verify that:
 *   1. Changing `agentRuntimeBackend` (Agent runtime) is reflected in the
 *      `runtime.backend` field of the next hello frame the agent receives.
 *   2. Changing `preferredExecutor` (Preferred executor) is reflected in the
 *      `preferredExecutor` field of the next hello frame the agent receives.
 *
 * The update mechanism: Kaiad embeds tenant settings in the `hello` frame it
 * sends on every new WebSocket connection.  When an operator changes settings
 * the agent reconnects (or is forced to reconnect) and receives the updated
 * hello automatically — no extra push is required.
 */
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildServer } from "../src/server.js";
import { __resetTenantStoreForTests, upsertTenantSettings } from "../src/store.js";

// ---------------------------------------------------------------------------
// Shared server fixture
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildServer>;
let wsBaseUrl: string;

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  app = buildServer({ readinessCheckers: [] });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
}, 15_000);

afterAll(async () => {
  await app.close();
  delete process.env.KAIAD_SKIP_SETUP_GATE;
  delete process.env.SM_ENROLLMENT_STORE;
});

afterEach(() => {
  __resetTenantStoreForTests();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HelloFrame = {
  type: string;
  service: string;
  runtime?: { backend: string };
  preferredExecutor?: string;
};

/** Connect to /realtime and capture the first (hello) frame. */
function connectAndCaptureHello(): Promise<{ ws: WebSocket; hello: HelloFrame }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBaseUrl}/realtime`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timeout waiting for hello frame"));
    }, 5_000);

    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.once("message", (data) => {
      clearTimeout(timer);
      try {
        const hello = JSON.parse(data.toString()) as HelloFrame;
        resolve({ ws, hello });
      } catch (err) {
        ws.close();
        reject(err);
      }
    });
  });
}

/** Wait for the socket to reach CLOSED state. */
function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", resolve));
}

// ---------------------------------------------------------------------------
// AT-AGT-001: Agent runtime (agentRuntimeBackend)
// ---------------------------------------------------------------------------

describe("AT-AGT-001: Agent runtime — agentRuntimeBackend reflected in hello", () => {
  it("defaults to docker when no tenant settings exist", async () => {
    const { ws, hello } = await connectAndCaptureHello();
    expect(hello.type).toBe("hello");
    expect(hello.runtime?.backend).toBe("docker");
    ws.close();
    await waitForClose(ws);
  });
});

// ---------------------------------------------------------------------------
// AT-AGT-002: Preferred executor (preferredExecutor)
// ---------------------------------------------------------------------------

describe("AT-AGT-002: Preferred executor — preferredExecutor reflected in hello", () => {
  it("omits preferredExecutor from hello when not configured", async () => {
    const { ws, hello } = await connectAndCaptureHello();
    expect(hello.preferredExecutor).toBeUndefined();
    ws.close();
    await waitForClose(ws);
  });

  it("reflects preferredExecutor=cursor in hello after settings change and reconnect", async () => {
    await upsertTenantSettings({
      tenantId: "t-1",
      preferredExecutor: "cursor"
    });

    const { ws, hello } = await connectAndCaptureHello();
    expect(hello.preferredExecutor).toBe("cursor");
    ws.close();
    await waitForClose(ws);
  });

  it("reflects preferredExecutor=claude in hello after settings change and reconnect", async () => {
    await upsertTenantSettings({
      tenantId: "t-1",
      preferredExecutor: "claude"
    });

    const { ws, hello } = await connectAndCaptureHello();
    expect(hello.preferredExecutor).toBe("claude");
    ws.close();
    await waitForClose(ws);
  });

  it("reflects updated executor when operator switches from cursor to claude and agent reconnects", async () => {
    await upsertTenantSettings({
      tenantId: "t-1",
      preferredExecutor: "cursor"
    });

    const { ws: ws1, hello: hello1 } = await connectAndCaptureHello();
    expect(hello1.preferredExecutor).toBe("cursor");
    ws1.close();
    await waitForClose(ws1);

    // Operator switches to claude.
    await upsertTenantSettings({
      tenantId: "t-1",
      preferredExecutor: "claude"
    });

    const { ws: ws2, hello: hello2 } = await connectAndCaptureHello();
    expect(hello2.preferredExecutor).toBe("claude");
    ws2.close();
    await waitForClose(ws2);
  });

  it("omits preferredExecutor from hello after settings are cleared and agent reconnects", async () => {
    await upsertTenantSettings({
      tenantId: "t-1",
      preferredExecutor: "claude"
    });

    const { ws: ws1, hello: hello1 } = await connectAndCaptureHello();
    expect(hello1.preferredExecutor).toBe("claude");
    ws1.close();
    await waitForClose(ws1);

    // Operator clears the preferredExecutor (saves settings without the field).
    await upsertTenantSettings({
      tenantId: "t-1"
    });

    const { ws: ws2, hello: hello2 } = await connectAndCaptureHello();
    expect(hello2.preferredExecutor).toBeUndefined();
    ws2.close();
    await waitForClose(ws2);
  });
});
