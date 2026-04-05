import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createNamedQueueMock,
  createRedisConnectionFromEnvMock,
  queueAddMock,
  queueCloseMock,
  redisQuitMock
} = vi.hoisted(() => ({
  createNamedQueueMock: vi.fn(),
  createRedisConnectionFromEnvMock: vi.fn(),
  queueAddMock: vi.fn().mockResolvedValue({}),
  queueCloseMock: vi.fn().mockResolvedValue(undefined),
  redisQuitMock: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@sm/queue", () => ({
  createNamedQueue: createNamedQueueMock,
  createRedisConnectionFromEnv: createRedisConnectionFromEnvMock
}));

import { createRuntimeQueueWiringFromEnv } from "../src/server.js";

describe("createRuntimeQueueWiringFromEnv", () => {
  beforeEach(() => {
    createNamedQueueMock.mockReset();
    createRedisConnectionFromEnvMock.mockReset();
    queueAddMock.mockClear();
    queueCloseMock.mockClear();
    redisQuitMock.mockClear();

    createRedisConnectionFromEnvMock.mockReturnValue({
      quit: redisQuitMock
    });
    createNamedQueueMock.mockImplementation(() => ({
      add: queueAddMock,
      close: queueCloseMock
    }));
  });

  it("returns null and skips queue wiring when REDIS_DISABLED=1", () => {
    const wiring = createRuntimeQueueWiringFromEnv({ REDIS_DISABLED: "1" });
    expect(wiring).toBeNull();
    expect(createRedisConnectionFromEnvMock).not.toHaveBeenCalled();
    expect(createNamedQueueMock).not.toHaveBeenCalled();
  });

  it("creates redis-backed enqueuers and closes resources", async () => {
    const wiring = createRuntimeQueueWiringFromEnv({ REDIS_URL: "redis://localhost:6379" });
    expect(wiring).not.toBeNull();
    expect(createRedisConnectionFromEnvMock).toHaveBeenCalledTimes(1);
    expect(createNamedQueueMock.mock.calls.map((call) => call[0])).toEqual([
      "github",
      "logIngestion",
      "agentCommands"
    ]);

    await wiring!.buildOptions.enqueueGithubJob?.({
      kind: "github_ingestion",
      tenantId: "t-1",
      eventType: "push"
    });
    await wiring!.buildOptions.enqueueLogIngestion?.({
      tenantId: "t-1",
      agentId: "a-1",
      serviceId: "svc-1",
      level: "error",
      message: "boom",
      ts: new Date().toISOString()
    });
    await wiring!.buildOptions.enqueueAgentCommand?.({
      agentId: "a-1",
      commandId: "cmd-1",
      payload: { type: "run_step", commandId: "cmd-1", shell: "echo hi", env: {} }
    });

    expect(queueAddMock.mock.calls.map((call) => call[0])).toEqual([
      "github-webhook",
      "log-ingestion",
      "agent-command"
    ]);

    await wiring!.close();
    expect(queueCloseMock).toHaveBeenCalledTimes(3);
    expect(redisQuitMock).toHaveBeenCalledTimes(1);
  });
});
