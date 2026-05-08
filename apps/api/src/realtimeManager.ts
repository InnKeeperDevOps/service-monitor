export type AgentSession = {
  agentId: string;
  socket: { send(data: string): void };
};

export type UiSubscriber = {
  tenantId: string;
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

export type CommandAck = {
  status: "accepted" | "completed" | "failed" | "cancelled";
  output?: string;
};

type PendingAwaiter = {
  resolve: (ack: CommandAck) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RealtimeManager {
  private sessions = new Map<string, AgentSession>();
  /** Last host_stats payload per agent (for observability / future UI). */
  private hostStatsByAgent = new Map<string, unknown>();
  /** Last app_stats payload per agent, keyed by containerId. */
  private appStatsByAgent = new Map<string, Map<string, unknown>>();
  /** Tenants the API has seen agents for — used to route UI subscribers. */
  private agentTenantById = new Map<string, string>();
  /** UI telemetry subscribers keyed by tenantId. */
  private uiSubscribersByTenant = new Map<string, Set<UiSubscriber>>();
  /** In-flight awaiters keyed by commandId, resolved when a terminal command_ack arrives. */
  private awaiters = new Map<string, PendingAwaiter>();
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

  setAppStats(agentId: string, containerId: string, payload: unknown): void {
    let inner = this.appStatsByAgent.get(agentId);
    if (!inner) {
      inner = new Map();
      this.appStatsByAgent.set(agentId, inner);
    }
    inner.set(containerId, payload);
  }

  /** Returns the latest app_stats payloads for an agent, or an empty array when none. */
  getAppStats(agentId: string): unknown[] {
    const inner = this.appStatsByAgent.get(agentId);
    if (!inner) return [];
    return [...inner.values()];
  }

  /** Remove an app's telemetry (e.g. on app_gone / container stopped). */
  deleteAppStats(agentId: string, containerId: string): void {
    const inner = this.appStatsByAgent.get(agentId);
    if (inner) {
      inner.delete(containerId);
      if (inner.size === 0) {
        this.appStatsByAgent.delete(agentId);
      }
    }
  }

  /** Record tenant binding for an agent so broadcasts can route correctly. */
  bindAgentTenant(agentId: string, tenantId: string): void {
    this.agentTenantById.set(agentId, tenantId);
  }

  getAgentTenant(agentId: string): string | undefined {
    return this.agentTenantById.get(agentId);
  }

  addUiSubscriber(sub: UiSubscriber): void {
    let set = this.uiSubscribersByTenant.get(sub.tenantId);
    if (!set) {
      set = new Set();
      this.uiSubscribersByTenant.set(sub.tenantId, set);
    }
    set.add(sub);
  }

  removeUiSubscriber(sub: UiSubscriber): void {
    const set = this.uiSubscribersByTenant.get(sub.tenantId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) {
      this.uiSubscribersByTenant.delete(sub.tenantId);
    }
  }

  /** Broadcast a pre-serialized JSON payload to every UI subscriber for a tenant. */
  broadcastToTenant(tenantId: string, payload: string): void {
    const set = this.uiSubscribersByTenant.get(tenantId);
    if (!set) return;
    for (const sub of set) {
      try {
        sub.socket.send(payload);
      } catch {
        // A broken subscriber socket will be cleaned up when the WS close fires.
      }
    }
  }

  /** Test helper — count of UI subscribers for a tenant. */
  countUiSubscribers(tenantId: string): number {
    return this.uiSubscribersByTenant.get(tenantId)?.size ?? 0;
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
    this.appStatsByAgent.delete(agentId);
    this.agentTenantById.delete(agentId);
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

  async acknowledgeCommand(agentId: string, commandId: string, ack?: CommandAck): Promise<boolean> {
    if (ack && (ack.status === "completed" || ack.status === "failed" || ack.status === "cancelled")) {
      const awaiter = this.awaiters.get(commandId);
      if (awaiter) {
        clearTimeout(awaiter.timer);
        this.awaiters.delete(commandId);
        awaiter.resolve(ack);
      }
    }
    return this.removePendingByCommandId(agentId, commandId);
  }

  /**
   * Wait for a terminal `command_ack` for `commandId`. Resolves with the ack
   * (status + output) or rejects on timeout. Install before `sendCommand`.
   */
  awaitCommandResult(commandId: string, timeoutMs: number): Promise<CommandAck> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaiters.delete(commandId);
        reject(new Error(`Timed out waiting for command_ack on ${commandId} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.awaiters.set(commandId, { resolve, timer });
    });
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

  /** Forcefully closes the realtime session for an agent, e.g. when an admin removes it. */
  disconnectAgent(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    const sock = session.socket as { close?: () => void };
    try {
      sock.close?.();
    } catch {
      // Closing the underlying socket is best-effort; the session is still removed below.
    }
    this.sessions.delete(agentId);
    this.hostStatsByAgent.delete(agentId);
    return true;
  }
}
