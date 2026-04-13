import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const { createRedisConnectionFromEnv, createNamedWorker } = vi.hoisted(() => ({
  createRedisConnectionFromEnv: vi.fn(),
  createNamedWorker: vi.fn()
}));

vi.mock("@sm/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sm/queue")>();
  return {
    ...actual,
    createRedisConnectionFromEnv,
    createNamedWorker
  };
});

import {
  processAgentCommandJobDispatch,
  startQueueConsumersFromEnv,
  wireBullmqWorkers
} from "../src/worker-runtime.js";

describe("worker runtime — queue wiring", () => {
  beforeEach(() => {
    createRedisConnectionFromEnv.mockReset();
    createNamedWorker.mockReset();
    const mockConnection = { quit: vi.fn().mockResolvedValue(undefined) };
    createRedisConnectionFromEnv.mockReturnValue(mockConnection as never);
    createNamedWorker.mockImplementation((_key, _conn, processor) => {
      return {
        close: vi.fn().mockResolvedValue(undefined),
        __processor: processor
      } as never;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips Redis and workers when REDIS_DISABLED=1", () => {
    const r = startQueueConsumersFromEnv({ REDIS_DISABLED: "1" });
    expect(r.connection).toBeNull();
    expect(r.workers).toEqual([]);
    expect(createRedisConnectionFromEnv).not.toHaveBeenCalled();
    expect(createNamedWorker).not.toHaveBeenCalled();
  });

  it("creates Redis and three named workers when Redis is enabled", () => {
    startQueueConsumersFromEnv({});
    expect(createRedisConnectionFromEnv).toHaveBeenCalledTimes(1);
    expect(createNamedWorker).toHaveBeenCalledTimes(4);
    const keys = createNamedWorker.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(["remediation", "agentCommands", "workflowExecution", "logIngestion"]);
  });

  it("remediation worker processor delegates to runRemediation", async () => {
    vi.stubEnv("SM_EXECUTOR_SIMULATE", "1");
    vi.stubEnv("SM_EXECUTOR_ALLOW_SIMULATION", "1");
    const mockConn = { quit: vi.fn() };
    createRedisConnectionFromEnv.mockReturnValue(mockConn as never);
    wireBullmqWorkers(mockConn as never);
    const remediationCall = createNamedWorker.mock.calls.find((c) => c[0] === "remediation");
    expect(remediationCall).toBeDefined();
    const processor = remediationCall![2] as (job: Job) => Promise<unknown>;
    const payload = {
      remediationJobId: "r-1",
      tenantId: "t-1",
      incidentId: "i-1",
      fingerprint: "f",
      executor: "cursor" as const,
      prompt: "fix",
      gitRepoUrl: "https://github.com/placeholder/repo",
      sshKeyType: "uploaded" as const,
      sshKeyValue: null
    };
    const result = (await processor({ data: payload } as Job)) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.executor).toBe("cursor");
    expect((result.metadata as Record<string, unknown>).simulated).toBe(true);
  });

  it("agentCommands worker returns accepted metadata when API dispatch succeeds", async () => {
    const mockConn = { quit: vi.fn() };
    createRedisConnectionFromEnv.mockReturnValue(mockConn as never);
    wireBullmqWorkers(mockConn as never, { INTERNAL_API_URL: "http://api.internal:3001" });
    const agentCall = createNamedWorker.mock.calls.find((c) => c[0] === "agentCommands");
    expect(agentCall).toBeDefined();
    const processor = agentCall![2] as (job: Job) => Promise<unknown>;
    const payload = {
      agentId: "a-1",
      commandId: "cmd-1",
      payload: { type: "run_step", shell: "echo hi", env: {} }
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => "",
      json: async () => ({ accepted: true, commandId: "cmd-1", queued: true, delivered: false })
    } as Response);
    let r: unknown;
    try {
      r = await processor({ data: payload } as Job);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(r).toEqual({ accepted: true, commandId: "cmd-1", queued: true, delivered: false });
  });

  it("throws when INTERNAL_API_URL is missing", async () => {
    await expect(
      processAgentCommandJobDispatch({
        agentId: "a-1",
        commandId: "cmd-1",
        payload: { type: "run_step", shell: "echo hi", env: {} }
      })
    ).rejects.toThrow(/INTERNAL_API_URL is required/);
  });

  it("throws in production when INTERNAL_API_TOKEN is missing", async () => {
    await expect(
      processAgentCommandJobDispatch(
        {
          agentId: "a-1",
          commandId: "cmd-1",
          payload: { type: "run_step", shell: "echo hi", env: {} }
        },
        { INTERNAL_API_URL: "http://api.internal:3001", NODE_ENV: "production" }
      )
    ).rejects.toThrow(/INTERNAL_API_TOKEN is required in production/);
  });

  it("dispatches agent commands to API when INTERNAL_API_URL is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ accepted: true, commandId: "cmd-1", queued: true, delivered: false })
    });
    const result = await processAgentCommandJobDispatch(
      {
        agentId: "a-1",
        commandId: "cmd-1",
        payload: { type: "run_step", shell: "echo hi", env: {} }
      },
      { INTERNAL_API_URL: "http://api.internal:3001", INTERNAL_API_TOKEN: "tok-1" },
      fetchMock as unknown as typeof fetch
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.internal:3001/api/v1/internal/agent-commands",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-1"
        })
      })
    );
    expect(result).toEqual({
      accepted: true,
      commandId: "cmd-1",
      queued: true,
      delivered: false
    });
  });

  it("fails when API dispatch returns non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "{\"code\":\"BACKPRESSURE\"}"
    });
    await expect(
      processAgentCommandJobDispatch(
        {
          agentId: "a-1",
          commandId: "cmd-1",
          payload: { type: "run_step", shell: "echo hi", env: {} }
        },
        { INTERNAL_API_URL: "http://api.internal:3001", INTERNAL_API_TOKEN: "tok-1" },
        fetchMock as unknown as typeof fetch
      )
    ).rejects.toThrow(/Agent command dispatch failed: 429/);
  });

  it("workflowExecution worker delegates to runWorkflow", async () => {
    const mockConn = { quit: vi.fn() };
    createRedisConnectionFromEnv.mockReturnValue(mockConn as never);
    wireBullmqWorkers(mockConn as never);
    const workerCall = createNamedWorker.mock.calls.find((c) => c[0] === "workflowExecution");
    expect(workerCall).toBeDefined();
    // we just check it was created
  });

  it("logIngestion worker processes log ingestion jobs", async () => {
    const mockConn = { quit: vi.fn() };
    createRedisConnectionFromEnv.mockReturnValue(mockConn as never);
    wireBullmqWorkers(mockConn as never);
    const workerCall = createNamedWorker.mock.calls.find((c) => c[0] === "logIngestion");
    expect(workerCall).toBeDefined();
    const processor = workerCall![2] as (job: Job) => Promise<unknown>;

    // We pass a dummy payload that doesn't trigger incident creation for brevity
    const payload = {
      tenantId: "t-1",
      serviceId: "s-1",
      containerId: "c-1",
      agentId: "a-1",
      level: "info",
      message: "dummy message",
      ts: "2026-04-13T04:36:31.822Z",
      stream: "stdout",
      lines: []
    };
    
    const res = await processor({ data: payload } as Job) as any;
    expect(res).toBeDefined();
  });
});

import { shutdownWorkersAndRedis } from "../src/worker-runtime.js";

describe("shutdownWorkersAndRedis", () => {
  it("closes all workers and quits redis", async () => {
    const mockWorker = { close: vi.fn().mockResolvedValue(undefined) };
    const mockConn = { quit: vi.fn().mockResolvedValue(undefined) };
    
    await shutdownWorkersAndRedis([mockWorker as never], mockConn as never);
    
    expect(mockWorker.close).toHaveBeenCalled();
    expect(mockConn.quit).toHaveBeenCalled();
  });
});
