import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// Deploy-a-specific-version endpoints. No DATABASE_URL here, so the
// build-store paths 503 after auth/validation — which is exactly the
// guard surface we want to pin.
const app = buildServer();

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const ADMIN = { authorization: "Bearer dev-token" };

describe("POST /api/v1/services/:id/deploy", () => {
  it("401 without a session", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/services/svc-1/deploy",
      payload: { buildId: "b-1" }
    });
    expect(r.statusCode).toBe(401);
  });

  it("400 when buildId is missing", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/services/svc-1/deploy",
      headers: ADMIN,
      payload: {}
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("BAD_REQUEST");
  });

  it("503 when the build store is unavailable (no DATABASE_URL)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/services/svc-1/deploy",
      headers: ADMIN,
      payload: { buildId: "b-1" }
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe("REGISTRY_UNAVAILABLE");
  });
});

describe("POST /api/v1/agents/:agentId/deploy", () => {
  it("401 without a session", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/agents/ag-1/deploy",
      payload: { serviceId: "svc-1", buildId: "b-1" }
    });
    expect(r.statusCode).toBe(401);
  });

  it("400 when serviceId/buildId missing", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/agents/ag-1/deploy",
      headers: ADMIN,
      payload: { serviceId: "svc-1" }
    });
    expect(r.statusCode).toBe(400);
  });

  it("404 when the agent does not exist", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/agents/ag-unknown/deploy",
      headers: ADMIN,
      payload: { serviceId: "svc-1", buildId: "b-1" }
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("NOT_FOUND");
  });
});
