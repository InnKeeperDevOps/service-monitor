import http from "node:http";
import { describe, expect, it } from "vitest";
import { createHealthServer } from "../src/health-server.js";
import type { Server } from "node:http";

async function listenRandom(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected TCP listen address");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function httpGetStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

describe("worker health server", () => {
  it("GET /health returns 200", async () => {
    const server = createHealthServer();
    const { port, close } = await listenRandom(server);
    try {
      const status = await httpGetStatus(`http://127.0.0.1:${port}/health`);
      expect(status).toBe(200);
    } finally {
      await close();
    }
  });

  it("GET /unknown returns 404", async () => {
    const server = createHealthServer();
    const { port, close } = await listenRandom(server);
    try {
      const status = await httpGetStatus(`http://127.0.0.1:${port}/unknown`);
      expect(status).toBe(404);
    } finally {
      await close();
    }
  });
});
