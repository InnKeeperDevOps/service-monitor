import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { createMemoryDomainStore, __resetDomainStoreForTests } from "../src/domainStore.js";

const AUTH = { authorization: "Bearer dev-token" };

describe("security", () => {
  describe("T-SEC-001: tenant isolation on incidents", () => {
    const domainStore = createMemoryDomainStore();
    const app = buildServer({ domainStore });

    beforeAll(async () => {
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      __resetDomainStoreForTests();
    });

    it("returns 404 with no body leak when tenant A requests tenant B incident", async () => {
      const otherInc = await domainStore.upsertIncident("t-other", {
        serviceId: "svc-1",
        fingerprint: "fp-cross-tenant",
        message: "secret error from other tenant"
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/incidents/${otherInc.id}`,
        headers: AUTH
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body).not.toHaveProperty("message", "secret error from other tenant");
      expect(body).not.toHaveProperty("tenantId", "t-other");
      expect(body).not.toHaveProperty("serviceId");
      expect(body).not.toHaveProperty("fingerprint");
    });
  });

  describe("T-SEC-002: invalid HMAC webhook rejected, no enqueue", () => {
    const enqueue = vi.fn();
    const app = buildServer({ enqueueGithubJob: enqueue });

    beforeAll(async () => {
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 401 and does not enqueue when HMAC signature is invalid", async () => {
      enqueue.mockClear();

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/github",
        payload: JSON.stringify({ ref: "refs/heads/main" }),
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000"
        }
      });

      expect(res.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });
});
