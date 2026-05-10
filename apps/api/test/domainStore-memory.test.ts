import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryDomainStore,
  __resetDomainStoreForTests,
  __seedAgentForTests,
} from "../src/domainStore.js";

const store = createMemoryDomainStore();

beforeEach(() => {
  __resetDomainStoreForTests();
});

describe("createMemoryDomainStore agent heartbeat and offline", () => {
  it("markAgentOffline sets status to offline for the same tenant", async () => {
    __seedAgentForTests({
      id: "a1",
      tenantId: "t1",
      name: "n",
      version: "1",
      status: "online",
      lastSeenAt: "2025-01-01T00:00:00.000Z",
      certFingerprint: null,
      allowedCapabilities: [],
      environment: "development",
    });
    await store.markAgentOffline("t1", "a1");
    const a = await store.getAgent("t1", "a1");
    expect(a?.status).toBe("offline");
  });

  it("markAgentOffline is a no-op when tenant does not match", async () => {
    __seedAgentForTests({
      id: "a1",
      tenantId: "t1",
      name: "n",
      version: "1",
      status: "online",
      lastSeenAt: "2025-01-01T00:00:00.000Z",
      certFingerprint: null,
      allowedCapabilities: [],
      environment: "development",
    });
    await store.markAgentOffline("t-other", "a1");
    const a = await store.getAgent("t1", "a1");
    expect(a?.status).toBe("online");
  });

  it("markAgentOffline is a no-op when the agent id is unknown", async () => {
    await store.markAgentOffline("t1", "missing");
    expect(await store.listAgents("t1")).toHaveLength(0);
  });

  it("recordAgentHeartbeat does not update an agent registered under another tenant", async () => {
    __seedAgentForTests({
      id: "shared-id",
      tenantId: "t1",
      name: "keep",
      version: "1.0.0",
      status: "online",
      lastSeenAt: "2025-01-01T00:00:00.000Z",
      certFingerprint: null,
      allowedCapabilities: [],
      environment: "development",
    });
    await store.recordAgentHeartbeat("t2", {
      agentId: "shared-id",
      version: "9.9.9",
    });
    const original = await store.getAgent("t1", "shared-id");
    expect(original?.tenantId).toBe("t1");
    expect(original?.version).toBe("1.0.0");
    expect(await store.listAgents("t2")).toHaveLength(0);
  });

  it("recordAgentHeartbeat keeps the prior version when the payload version is null", async () => {
    __seedAgentForTests({
      id: "a1",
      tenantId: "t1",
      name: "n",
      version: "2.0.0",
      status: "online",
      lastSeenAt: "2025-01-01T00:00:00.000Z",
      certFingerprint: null,
      allowedCapabilities: [],
      environment: "development",
    });
    await store.recordAgentHeartbeat("t1", { agentId: "a1", version: null });
    const a = await store.getAgent("t1", "a1");
    expect(a?.version).toBe("2.0.0");
    expect(a?.status).toBe("online");
  });

  it("recordAgentHeartbeat creates a new agent with null version", async () => {
    await store.recordAgentHeartbeat("t1", { agentId: "new-a", version: null });
    const a = await store.getAgent("t1", "new-a");
    expect(a?.version).toBeNull();
    expect(a?.status).toBe("online");
  });
});
