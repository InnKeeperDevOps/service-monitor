import { describe, expect, it, vi, beforeEach } from "vitest";
import { RealtimeManager, type PendingCommandRedis } from "../src/realtimeManager.js";

function createMockSocket() {
  return { send: vi.fn() };
}

function createMockRedis(initial: Record<string, string[]> = {}): PendingCommandRedis {
  const store = new Map<string, string[]>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, [...v]);
  }

  return {
    async rpush(key: string, value: string) {
      const list = store.get(key) ?? [];
      list.push(value);
      store.set(key, list);
      return list.length;
    },
    async lpop(key: string) {
      const list = store.get(key);
      if (!list || list.length === 0) return null;
      return list.shift()!;
    },
    async lrange(key: string, start: number, stop: number) {
      const list = store.get(key) ?? [];
      const end = stop < 0 ? list.length : stop + 1;
      return list.slice(start, end);
    },
    async llen(key: string) {
      return (store.get(key) ?? []).length;
    },
    async del(key: string) {
      const had = store.has(key) ? 1 : 0;
      store.delete(key);
      return had;
    },
    async lrem(key: string, count: number, value: string) {
      const list = store.get(key) ?? [];
      if (count === 0) return 0;
      const next: string[] = [];
      let removed = 0;
      let budget = Math.abs(count);
      for (const entry of list) {
        const shouldRemove = budget > 0 && entry === value && (count > 0 || count < 0);
        if (shouldRemove) {
          removed += 1;
          budget -= 1;
          continue;
        }
        next.push(entry);
      }
      store.set(key, next);
      return removed;
    }
  };
}

describe("RealtimeManager", () => {
  describe("without redis", () => {
    it("tracks connected agents", () => {
      const mgr = new RealtimeManager();
      const socket = createMockSocket();
      mgr.registerAgent({ agentId: "a-1", socket });
      expect(mgr.getConnectedAgentIds()).toEqual(["a-1"]);
    });

    it("sendCommand delivers to connected agent socket", async () => {
      const mgr = new RealtimeManager();
      const socket = createMockSocket();
      await mgr.registerAgent({ agentId: "a-1", socket });
      await mgr.sendCommand("a-1", '{"type":"restart"}');
      expect(socket.send).toHaveBeenCalledWith('{"type":"restart"}');
    });

    it("sendCommand fails for offline agents without redis", async () => {
      const mgr = new RealtimeManager();
      await expect(mgr.sendCommand("a-offline", '{"type":"restart"}')).rejects.toThrow(
        /offline and no durable command queue is configured/
      );
    });

    it("unregisterAgent removes agent from connected set", async () => {
      const mgr = new RealtimeManager();
      const socket = createMockSocket();
      await mgr.registerAgent({ agentId: "a-1", socket });
      mgr.unregisterAgent("a-1");
      expect(mgr.getConnectedAgentIds()).toEqual([]);
    });

    it("setAppStats and getAppStats round-trip by containerId", () => {
      const mgr = new RealtimeManager();
      mgr.setAppStats("a-1", "c-1", { cpuPercent: 10 });
      mgr.setAppStats("a-1", "c-2", { cpuPercent: 20 });
      const apps = mgr.getAppStats("a-1");
      expect(apps).toHaveLength(2);
      expect(apps).toEqual(
        expect.arrayContaining([{ cpuPercent: 10 }, { cpuPercent: 20 }])
      );
      mgr.deleteAppStats("a-1", "c-1");
      expect(mgr.getAppStats("a-1")).toEqual([{ cpuPercent: 20 }]);
    });

    it("broadcastToTenant fans out to every UI subscriber for that tenant", () => {
      const mgr = new RealtimeManager();
      const sockA = createMockSocket();
      const sockB = createMockSocket();
      const otherTenant = createMockSocket();
      const subA = { tenantId: "t-1", socket: sockA };
      const subB = { tenantId: "t-1", socket: sockB };
      const subOther = { tenantId: "t-2", socket: otherTenant };
      mgr.addUiSubscriber(subA);
      mgr.addUiSubscriber(subB);
      mgr.addUiSubscriber(subOther);
      expect(mgr.countUiSubscribers("t-1")).toBe(2);

      mgr.broadcastToTenant("t-1", '{"hello":"world"}');
      expect(sockA.send).toHaveBeenCalledWith('{"hello":"world"}');
      expect(sockB.send).toHaveBeenCalledWith('{"hello":"world"}');
      expect(otherTenant.send).not.toHaveBeenCalled();

      mgr.removeUiSubscriber(subA);
      expect(mgr.countUiSubscribers("t-1")).toBe(1);
    });

    it("unregisterAgent clears host + app stats and tenant binding", async () => {
      const mgr = new RealtimeManager();
      const socket = createMockSocket();
      await mgr.registerAgent({ agentId: "a-x", socket });
      mgr.bindAgentTenant("a-x", "t-1");
      mgr.setHostStats("a-x", { cpuPercent: 5 });
      mgr.setAppStats("a-x", "c-1", { cpuPercent: 1 });
      mgr.unregisterAgent("a-x");
      expect(mgr.getHostStats("a-x")).toBeUndefined();
      expect(mgr.getAppStats("a-x")).toEqual([]);
      expect(mgr.getAgentTenant("a-x")).toBeUndefined();
    });
  });

  describe("with redis", () => {
    it("registerAgent replays pending commands from Redis", async () => {
      const redis = createMockRedis({
        "sm:pending:agent:a-1:commands": ['{"type":"cmd1"}', '{"type":"cmd2"}']
      });
      const mgr = new RealtimeManager({ redis });
      const socket = createMockSocket();

      await mgr.registerAgent({ agentId: "a-1", socket });

      expect(socket.send).toHaveBeenCalledTimes(2);
      expect(socket.send).toHaveBeenNthCalledWith(1, '{"type":"cmd1"}');
      expect(socket.send).toHaveBeenNthCalledWith(2, '{"type":"cmd2"}');
    });

    it("registerAgent keeps replayed commands pending until acknowledged", async () => {
      const redis = createMockRedis({
        "sm:pending:agent:a-1:commands": ['{"type":"cmd1"}']
      });
      const mgr = new RealtimeManager({ redis });
      const socket = createMockSocket();

      await mgr.registerAgent({ agentId: "a-1", socket });
      expect(await redis.llen("sm:pending:agent:a-1:commands")).toBe(1);
    });

    it("sendCommand persists to Redis when agent is offline", async () => {
      const redis = createMockRedis();
      const mgr = new RealtimeManager({ redis });

      await mgr.sendCommand("a-offline", '{"type":"restart"}');

      const pending = await redis.lrange("sm:pending:agent:a-offline:commands", 0, -1);
      expect(pending).toEqual(['{"type":"restart"}']);
    });

    it("sendCommand persists to Redis AND delivers to socket when online", async () => {
      const redis = createMockRedis();
      const mgr = new RealtimeManager({ redis });
      const socket = createMockSocket();
      await mgr.registerAgent({ agentId: "a-1", socket });

      await mgr.sendCommand("a-1", '{"type":"restart"}');

      expect(socket.send).toHaveBeenCalledWith('{"type":"restart"}');
      const pending = await redis.lrange("sm:pending:agent:a-1:commands", 0, -1);
      expect(pending).toEqual(['{"type":"restart"}']);
    });

    it("sendCommand deduplicates pending queue entries by commandId", async () => {
      const redis = createMockRedis();
      const mgr = new RealtimeManager({ redis });

      const command = '{"type":"run_step","commandId":"cmd-1","shell":"echo hi","env":{}}';
      await mgr.sendCommand("a-1", command);
      await mgr.sendCommand("a-1", command);

      const pending = await redis.lrange("sm:pending:agent:a-1:commands", 0, -1);
      expect(pending).toEqual([command]);
    });

    it("acknowledgeCommand removes matching pending command by commandId", async () => {
      const redis = createMockRedis();
      const mgr = new RealtimeManager({ redis });
      await mgr.sendCommand("a-1", '{"type":"run_step","commandId":"cmd-1","shell":"echo hi","env":{}}');
      await mgr.sendCommand("a-1", '{"type":"run_step","commandId":"cmd-2","shell":"echo hi","env":{}}');

      const acknowledged = await mgr.acknowledgeCommand("a-1", "cmd-1");

      expect(acknowledged).toBe(true);
      const pending = await redis.lrange("sm:pending:agent:a-1:commands", 0, -1);
      expect(pending).toEqual(['{"type":"run_step","commandId":"cmd-2","shell":"echo hi","env":{}}']);
    });

    it("sendCommand enforces backpressure limit", async () => {
      const redis = createMockRedis();
      const mgr = new RealtimeManager({ redis, maxPendingPerAgent: 2 });

      await mgr.sendCommand("a-1", '{"type":"cmd1"}');
      await mgr.sendCommand("a-1", '{"type":"cmd2"}');

      await expect(mgr.sendCommand("a-1", '{"type":"cmd3"}')).rejects.toThrow(
        /Backpressure.*a-1.*2 pending.*max 2/
      );
    });

    it("unregisterAgent causes subsequent sends to persist only in Redis", async () => {
      const redis = createMockRedis();
      const mgr = new RealtimeManager({ redis });
      const socket = createMockSocket();
      await mgr.registerAgent({ agentId: "a-1", socket });

      mgr.unregisterAgent("a-1");
      socket.send.mockClear();

      await mgr.sendCommand("a-1", '{"type":"restart"}');

      expect(socket.send).not.toHaveBeenCalled();
      const pending = await redis.lrange("sm:pending:agent:a-1:commands", 0, -1);
      expect(pending).toEqual(['{"type":"restart"}']);
    });
  });
});
