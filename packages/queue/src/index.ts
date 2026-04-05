import { QUEUE_NAMES } from "@sm/contracts";
import { Queue, Worker } from "bullmq";
import type { Processor, QueueOptions, WorkerOptions } from "bullmq";
import { Redis } from "ioredis";

export { QUEUE_NAMES };

export type QueueNameKey = keyof typeof QUEUE_NAMES;

const bullmqConnectionDefaults = { maxRetriesPerRequest: null } as const;

export function queueNameFor(key: QueueNameKey): string {
  return QUEUE_NAMES[key];
}

export function createRedisConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): Redis {
  const url = env.REDIS_URL;
  if (url) {
    return new Redis(url, { ...bullmqConnectionDefaults });
  }
  const host = env.REDIS_HOST ?? "127.0.0.1";
  const portRaw = env.REDIS_PORT;
  const parsed =
    portRaw !== undefined && portRaw !== "" ? Number.parseInt(portRaw, 10) : 6379;
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : 6379;
  const password = env.REDIS_PASSWORD;
  return new Redis({
    host,
    port,
    password: password !== undefined && password !== "" ? password : undefined,
    ...bullmqConnectionDefaults
  });
}

export function createNamedQueue<T = unknown>(
  nameKey: QueueNameKey,
  connection: Redis,
  opts?: Omit<QueueOptions, "connection">
): Queue<T> {
  const name = QUEUE_NAMES[nameKey];
  return new Queue<T>(name, { connection, ...opts });
}

export function createNamedWorker<T = unknown, R = void, N extends string = string>(
  nameKey: QueueNameKey,
  connection: Redis,
  processor: Processor<T, R, N>,
  opts?: Omit<WorkerOptions, "connection">
): Worker<T, R, N> {
  const name = QUEUE_NAMES[nameKey];
  return new Worker<T, R, N>(name, processor, { connection, ...opts });
}

/** Redis list key for durable pending agent commands (FIFO via RPUSH + LPOP). */
export function pendingCommandsKey(agentId: string): string {
  return `sm:pending:agent:${agentId}:commands`;
}

export type PendingAgentCommandRedis = Pick<Redis, "rpush" | "lpop" | "lrange">;

export async function enqueuePendingAgentCommand(
  redis: PendingAgentCommandRedis,
  agentId: string,
  commandJson: string
): Promise<number> {
  return redis.rpush(pendingCommandsKey(agentId), commandJson);
}

export async function dequeuePendingAgentCommand(
  redis: PendingAgentCommandRedis,
  agentId: string
): Promise<string | null> {
  const value = await redis.lpop(pendingCommandsKey(agentId));
  if (value === null || value === undefined) {
    return null;
  }
  return value;
}

export async function peekPendingAgentCommands(
  redis: PendingAgentCommandRedis,
  agentId: string,
  limit: number
): Promise<string[]> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }
  const lastIndex = limit - 1;
  return redis.lrange(pendingCommandsKey(agentId), 0, lastIndex);
}
