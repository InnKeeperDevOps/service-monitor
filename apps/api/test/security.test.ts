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
});
