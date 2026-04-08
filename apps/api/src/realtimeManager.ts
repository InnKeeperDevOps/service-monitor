export type AgentSession = {
  agentId: string;
  socket: { send(data: string): void };
};

export type PendingCommandRedis = {
  rpush(key: string, value: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  del(key: string): Promise<number>;
  lrem?(key: string, count: number, value: string): Promise<number>;
};

export type RealtimeManagerOptions = {
  redis?: PendingCommandRedis;
  maxPendingPerAgent?: number;
};

const DEFAULT_MAX_PENDING = 100;

function pendingCommandsKey(agentId: string): string {
  return `sm:pending:agent:${agentId}:commands`;
}

type DispatchResult = {
  queued: boolean;
  delivered: boolean;
};

function extractCommandId(commandJson: string): string | null {
  try {
    const parsed = JSON.parse(commandJson) as Record<string, unknown>;
    return typeof parsed.commandId === "string" && parsed.commandId.length > 0 ? parsed.commandId : null;
  } catch {
    return null;
  }
}

export class RealtimeManager {
  private sessions = new Map<string, AgentSession>();
  /** Last host_stats payload per agent (for observability / future UI). */
  private hostStatsByAgent = new Map<string, unknown>();
  private redis?: PendingCommandRedis;
  private maxPending: number;

  constructor(opts: RealtimeManagerOptions = {}) {
    this.redis = opts.redis;
    this.maxPending = opts.maxPendingPerAgent ?? DEFAULT_MAX_PENDING;
  }

  setHostStats(agentId: string, payload: unknown): void {
    this.hostStatsByAgent.set(agentId, payload);
  }

  getHostStats(agentId: string): unknown | undefined {
    return this.hostStatsByAgent.get(agentId);
  }

  async registerAgent(session: AgentSession): Promise<void> {
    this.sessions.set(session.agentId, session);

    if (this.redis) {
      const key = pendingCommandsKey(session.agentId);
      const pending = await this.redis.lrange(key, 0, -1);
      for (const cmd of pending) {
        session.socket.send(cmd);
      }
    }
  }

  unregisterAgent(agentId: string): void {
    this.sessions.delete(agentId);
    this.hostStatsByAgent.delete(agentId);
  }

  private async removePendingByCommandId(agentId: string, commandId: string): Promise<boolean> {
    if (!this.redis) return false;
    const key = pendingCommandsKey(agentId);
    const pending = await this.redis.lrange(key, 0, -1);
    const match = pending.find((entry) => extractCommandId(entry) === commandId);
    if (!match) return false;

    if (this.redis.lrem) {
      const removed = await this.redis.lrem(key, 1, match);
      return removed > 0;
    }

    await this.redis.del(key);
    let kept = 0;
    for (const entry of pending) {
      if (entry === match) continue;
      await this.redis.rpush(key, entry);
      kept += 1;
    }
    if (kept === 0) {
      await this.redis.del(key);
    }
    return true;
  }

  async acknowledgeCommand(agentId: string, commandId: string): Promise<boolean> {
    return this.removePendingByCommandId(agentId, commandId);
  }

  async sendCommand(agentId: string, commandJson: string): Promise<DispatchResult> {
    const commandId = extractCommandId(commandJson);
    let queued = false;
    if (this.redis) {
      const key = pendingCommandsKey(agentId);
      let shouldEnqueue = true;
      if (commandId) {
        const pending = await this.redis.lrange(key, 0, -1);
        shouldEnqueue = !pending.some((entry) => extractCommandId(entry) === commandId);
      }
      if (shouldEnqueue) {
        const len = await this.redis.llen(key);
        if (len >= this.maxPending) {
          throw new Error(
            `Backpressure: agent ${agentId} has ${len} pending commands (max ${this.maxPending})`
          );
        }
        await this.redis.rpush(key, commandJson);
      }
      queued = true;
    }

    const session = this.sessions.get(agentId);
    if (session) {
      session.socket.send(commandJson);
    }
    const delivered = Boolean(session);
    if (!queued && !delivered) {
      throw new Error(`Agent ${agentId} is offline and no durable command queue is configured`);
    }
    return { queued, delivered };
  }

  getConnectedAgentIds(): string[] {
    return [...this.sessions.keys()];
  }
}
