import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_NAMES } from "@sm/contracts";
import {
  createNamedQueue,
  createNamedWorker,
  createRedisConnectionFromEnv,
  dequeuePendingAgentCommand,
  enqueuePendingAgentCommand,
  peekPendingAgentCommands,
  pendingCommandsKey,
  queueNameFor
} from "../src/index.js";

const { RedisMock } = vi.hoisted(() => ({
  RedisMock: vi.fn()
}));

vi.mock("ioredis", () => ({
  Redis: RedisMock
}));

const { QueueMock, WorkerMock } = vi.hoisted(() => ({
  QueueMock: vi.fn(),
  WorkerMock: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: QueueMock,
  Worker: WorkerMock
}));

describe("queue helpers", () => {
  it("resolves queue names from contracts", () => {
    expect(queueNameFor("remediation")).toBe("remediation");
    expect(queueNameFor("agentCommands")).toBe("agent-commands");
  });
});

describe("createRedisConnectionFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("constructs Redis from REDIS_URL with BullMQ-friendly options", () => {
    const env = { REDIS_URL: "redis://localhost:6379" };
    createRedisConnectionFromEnv(env);
    expect(RedisMock).toHaveBeenCalledTimes(1);
    expect(RedisMock).toHaveBeenCalledWith(
      "redis://localhost:6379",
      expect.objectContaining({ maxRetriesPerRequest: null })
    );
  });

  it("constructs Redis from host, port, and optional password", () => {
    const env = {
      REDIS_HOST: "redis.example",
      REDIS_PORT: "6380",
      REDIS_PASSWORD: "secret"
    };
    createRedisConnectionFromEnv(env);
    expect(RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "redis.example",
        port: 6380,
        password: "secret",
        maxRetriesPerRequest: null
      })
    );
  });

  it("defaults host and port when unset", () => {
    const env: NodeJS.ProcessEnv = {};
    createRedisConnectionFromEnv(env);
    expect(RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 6379,
        maxRetriesPerRequest: null
      })
    );
  });
});

describe("createNamedQueue", () => {
  const fakeConnection = { tag: "redis" };

  beforeEach(() => {
    vi.clearAllMocks();
    QueueMock.mockImplementation((name: string, opts: { connection: unknown }) => ({ name, opts }));
  });

  it("creates a Queue with the contract name for the key", () => {
    createNamedQueue("remediation", fakeConnection as never);
    expect(QueueMock).toHaveBeenCalledWith(QUEUE_NAMES.remediation, {
      connection: fakeConnection
    });
  });

  it("maps agentCommands to agent-commands queue name", () => {
    createNamedQueue("agentCommands", fakeConnection as never);
    expect(QueueMock).toHaveBeenCalledWith(QUEUE_NAMES.agentCommands, {
      connection: fakeConnection
    });
  });
});

describe("createNamedWorker", () => {
  const fakeConnection = { tag: "redis" };
  const processor = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    WorkerMock.mockImplementation(
      (name: string, proc: unknown, opts: { connection: unknown }) => ({ name, proc, opts })
    );
  });

  it("creates a Worker with the contract queue name and processor", () => {
    createNamedWorker("github", fakeConnection as never, processor);
    expect(WorkerMock).toHaveBeenCalledWith(QUEUE_NAMES.github, processor, {
      connection: fakeConnection
    });
  });

  it("forwards extra worker options without overriding connection", () => {
    createNamedWorker("remediation", fakeConnection as never, processor, { concurrency: 4 });
    expect(WorkerMock).toHaveBeenCalledWith(QUEUE_NAMES.remediation, processor, {
      connection: fakeConnection,
      concurrency: 4
    });
  });
});

/** In-memory Redis list mock: RPUSH appends, LPOP shifts head, LRANGE reads slice (Redis semantics). */
function createRedisListMock() {
  const lists = new Map<string, string[]>();

  const rpush = vi.fn(async (key: string, ...values: string[]) => {
    let list = lists.get(key);
    if (!list) {
      list = [];
      lists.set(key, list);
    }
    list.push(...values);
    return list.length;
  });

  const lpop = vi.fn(async (key: string) => {
    const list = lists.get(key);
    if (!list || list.length === 0) {
      return null;
    }
    return list.shift() ?? null;
  });

  const lrange = vi.fn(async (key: string, start: number, stop: number) => {
    const list = lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    let e = stop < 0 ? len + stop : stop;
    if (e < 0) {
      e = 0;
    }
    if (s > e || s >= len) {
      return [];
    }
    const end = Math.min(e, len - 1);
    return list.slice(s, end + 1);
  });

  return { rpush, lpop, lrange, lists };
}

describe("pending agent command durability helpers", () => {
  it("pendingCommandsKey uses stable sm:pending namespace and agent id", () => {
    expect(pendingCommandsKey("agent-42")).toBe("sm:pending:agent:agent-42:commands");
  });

  it("enqueue uses RPUSH and dequeue uses LPOP in FIFO order", async () => {
    const redis = createRedisListMock();
    const agentId = "a1";

    await enqueuePendingAgentCommand(redis, agentId, '{"cmd":1}');
    await enqueuePendingAgentCommand(redis, agentId, '{"cmd":2}');

    expect(redis.rpush).toHaveBeenCalledWith(pendingCommandsKey(agentId), '{"cmd":1}');
    expect(redis.rpush).toHaveBeenCalledWith(pendingCommandsKey(agentId), '{"cmd":2}');

    const first = await dequeuePendingAgentCommand(redis, agentId);
    const second = await dequeuePendingAgentCommand(redis, agentId);
    expect(first).toBe('{"cmd":1}');
    expect(second).toBe('{"cmd":2}');

    expect(redis.lpop).toHaveBeenCalledWith(pendingCommandsKey(agentId));
  });

  it("dequeue on empty list returns null", async () => {
    const redis = createRedisListMock();
    await expect(dequeuePendingAgentCommand(redis, "empty-agent")).resolves.toBeNull();
  });

  it("peekPendingAgentCommands uses LRANGE from head with limit", async () => {
    const redis = createRedisListMock();
    const agentId = "peek-agent";
    const key = pendingCommandsKey(agentId);

    await redis.rpush(key, "a", "b", "c");

    await expect(peekPendingAgentCommands(redis, agentId, 2)).resolves.toEqual(["a", "b"]);
    expect(redis.lrange).toHaveBeenCalledWith(key, 0, 1);

    await expect(peekPendingAgentCommands(redis, agentId, 10)).resolves.toEqual(["a", "b", "c"]);
  });

  it("peekPendingAgentCommands returns empty array for non-positive limit", async () => {
    const redis = createRedisListMock();
    await expect(peekPendingAgentCommands(redis, "x", 0)).resolves.toEqual([]);
    await expect(peekPendingAgentCommands(redis, "x", -1)).resolves.toEqual([]);
    expect(redis.lrange).not.toHaveBeenCalled();
  });
});
