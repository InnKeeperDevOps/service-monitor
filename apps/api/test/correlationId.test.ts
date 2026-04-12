import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CORRELATION_HEADER } from "@sm/contracts";
import { buildServer } from "../src/server.js";

const app = buildServer();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("correlationIdPlugin", () => {
  it("generates a correlation id when none is provided", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);

    const correlationId = response.headers[CORRELATION_HEADER];
    expect(typeof correlationId).toBe("string");
    expect((correlationId as string).length).toBeGreaterThan(0);
  });

  it("preserves an existing correlation id from the request", async () => {
    const existing = "test-corr-id-12345";
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { [CORRELATION_HEADER]: existing }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers[CORRELATION_HEADER]).toBe(existing);
  });

  it("generates unique ids for separate requests", async () => {
    const r1 = await app.inject({ method: "GET", url: "/health" });
    const r2 = await app.inject({ method: "GET", url: "/health" });
    expect(r1.headers[CORRELATION_HEADER]).not.toBe(r2.headers[CORRELATION_HEADER]);
  });

  it("correlation id propagates through authenticated API flow", async () => {
    const traceId = "trace-auth-flow-002";
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        authorization: "Bearer dev-token",
        [CORRELATION_HEADER]: traceId
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[CORRELATION_HEADER]).toBe(traceId);
  });
});
