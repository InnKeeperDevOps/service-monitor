import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { __resetDomainStoreForTests } from "../src/domainStore.js";
import {
  __resetAuthStoreForTests,
  createMemoryAuthStore,
  seedDevUser
} from "../src/memoryAuthStore.js";
import { __resetTenantStoreForTests } from "../src/store.js";

const enqueuedAgentCommands: unknown[] = [];
let app: ReturnType<typeof buildServer>;
let token: string;

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  __resetAuthStoreForTests();
  const authStore = createMemoryAuthStore();
  await seedDevUser(authStore);
  app = buildServer({
    authStore,
    enqueueAgentCommand: (job) => {
      enqueuedAgentCommands.push(job);
    }
  });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "admin@example.com", password: "admin" }
  });
  token = (res.json() as { token: string }).token;
});

beforeEach(() => {
  __resetDomainStoreForTests();
  __resetTenantStoreForTests();
  enqueuedAgentCommands.splice(0);
});

afterAll(async () => {
  await app.close();
});

async function bringAgentOnline(agentId: string) {
  const ws = await app.injectWS("/realtime");
  await new Promise<void>((r) => ws.once("message", () => r())); // hello
  ws.send(
    JSON.stringify({
      type: "heartbeat",
      agentId,
      ts: new Date().toISOString(),
      capacity: 4,
      tenantId: "t-1"
    })
  );
  await new Promise<void>((r) => ws.once("message", () => r())); // ack
  return ws;
}

async function createSshKey(name = "deploy") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-keys",
    headers: { authorization: `Bearer ${token}` },
    payload: { name, type: "uploaded", privateKey: "fake-key-material" }
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createService(opts: { sshKeyId?: string; agentId: string; name: string }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/services",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: opts.name,
      gitRepoUrl: `git@github.com:example/${opts.name}.git`,
      sshKeyId: opts.sshKeyId,
      branch: "main",
      agentIds: [opts.agentId]
    }
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function listGroupsForService(serviceId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/services/${serviceId}/error-groups`,
    headers: { authorization: `Bearer ${token}` }
  });
  return (res.json() as { groups: { status: string; sampleMessage: string }[] }).groups;
}

describe("auto-fix loop end-to-end", () => {
  it("dispatches a run_fix_plan command when an app_log_error arrives for a service with sshKeyId", async () => {
    const ws = await bringAgentOnline("a-fix");
    const sshKeyId = await createSshKey();
    const serviceId = await createService({ sshKeyId, agentId: "a-fix", name: "checkout" });

    const ack = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(
      JSON.stringify({
        type: "app_log_error",
        agentId: "a-fix",
        serviceId,
        ts: new Date().toISOString(),
        message: "TypeError: cannot read property foo of null",
        contextLines: ["startup ok", "request received", "boom"]
      })
    );
    await ack;
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(enqueuedAgentCommands).toHaveLength(1);
    const job = enqueuedAgentCommands[0] as { agentId: string; payload: Record<string, unknown> };
    expect(job.agentId).toBe("a-fix");
    expect(job.payload.type).toBe("run_fix_plan");
    expect(job.payload.gitRepoUrl).toBe("git@github.com:example/checkout.git");
    expect(job.payload.branch).toBe("main");
    expect(job.payload.sshKeyType).toBe("uploaded");
    expect(job.payload.sshKeyValue).toBe("fake-key-material");
    expect(Array.isArray(job.payload.contextLines)).toBe(true);

    const groups = await listGroupsForService(serviceId);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("fixing");
    expect(groups[0].sampleMessage).toContain("TypeError");
    ws.terminate();
  });

  it("marks the group missing_auth and skips dispatch when service has no sshKeyId", async () => {
    const ws = await bringAgentOnline("a-noauth");
    const serviceId = await createService({ agentId: "a-noauth", name: "noauth" });

    const ack = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(
      JSON.stringify({
        type: "app_log_error",
        agentId: "a-noauth",
        serviceId,
        ts: new Date().toISOString(),
        message: "ECONNREFUSED 127.0.0.1:5432",
        contextLines: []
      })
    );
    await ack;
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(enqueuedAgentCommands).toHaveLength(0);
    const groups = await listGroupsForService(serviceId);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("missing_auth");
    ws.terminate();
  });

  it("filters out user-input errors and does not create a group", async () => {
    const ws = await bringAgentOnline("a-userinp");
    const sshKeyId = await createSshKey("uikey");
    const serviceId = await createService({ sshKeyId, agentId: "a-userinp", name: "uinput" });

    const ack = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(
      JSON.stringify({
        type: "app_log_error",
        agentId: "a-userinp",
        serviceId,
        ts: new Date().toISOString(),
        message: "HTTP 400 bad request: missing required field email",
        contextLines: []
      })
    );
    await ack;
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(enqueuedAgentCommands).toHaveLength(0);
    const groups = await listGroupsForService(serviceId);
    expect(groups).toHaveLength(0);
    ws.terminate();
  });
});
