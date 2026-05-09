import { onMounted, onUnmounted, reactive, watchEffect } from "vue";
import {
  openTelemetryStream,
  type AgentAppTelemetry,
  type AgentTelemetry,
  type ErrorGroup,
  type UiTelemetryEvent
} from "../../lib/api.js";

export type LiveTelemetry = {
  host: Record<string, AgentTelemetry>;
  apps: Record<string, Record<string, AgentAppTelemetry>>;
  presence: Record<string, boolean>;
  errorGroups: Record<string, ErrorGroup>;
  connected: boolean;
};

const STALE_MS = 30_000;
const PRUNE_INTERVAL_MS = 5_000;

export function useTelemetryStream(enabled: () => boolean = () => true): LiveTelemetry {
  const state = reactive<LiveTelemetry>({
    host: {},
    apps: {},
    presence: {},
    errorGroups: {},
    connected: false
  });

  let ws: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let closing = false;

  function applyEvent(evt: UiTelemetryEvent): void {
    switch (evt.type) {
      case "host_stats":
        state.host[evt.agentId] = { ...evt.stats } as AgentTelemetry;
        break;
      case "app_stats": {
        if (!state.apps[evt.agentId]) state.apps[evt.agentId] = {};
        state.apps[evt.agentId][evt.containerId] = {
          ...evt.stats,
          containerId: evt.containerId
        } as AgentAppTelemetry;
        break;
      }
      case "agent_presence":
        if (!evt.websocketConnected) {
          delete state.apps[evt.agentId];
          delete state.host[evt.agentId];
          state.presence[evt.agentId] = false;
        } else {
          state.presence[evt.agentId] = true;
        }
        break;
      case "app_gone":
        if (state.apps[evt.agentId]) {
          delete state.apps[evt.agentId][evt.containerId];
        }
        break;
      case "error_group_updated":
        state.errorGroups[evt.group.id] = evt.group;
        break;
    }
  }

  function pruneStale(): void {
    const now = Date.now();
    for (const agentId of Object.keys(state.host)) {
      if (now - new Date(state.host[agentId].ts).getTime() >= STALE_MS) {
        delete state.host[agentId];
      }
    }
    for (const agentId of Object.keys(state.apps)) {
      const inner = state.apps[agentId];
      for (const cid of Object.keys(inner)) {
        if (now - new Date(inner[cid].ts).getTime() >= STALE_MS) {
          delete inner[cid];
        }
      }
      if (Object.keys(inner).length === 0) {
        delete state.apps[agentId];
      }
    }
  }

  function scheduleReconnect(): void {
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    try {
      ws = openTelemetryStream();
    } catch (err) {
      console.error("[telemetry] failed to open WS", err);
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      attempt = 0;
      state.connected = true;
    });
    ws.addEventListener("message", (ev) => {
      let parsed: UiTelemetryEvent;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as UiTelemetryEvent;
      } catch {
        return;
      }
      applyEvent(parsed);
    });
    ws.addEventListener("close", () => {
      state.connected = false;
      if (!closing) scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close handler reconnects
    });
  }

  function start(): void {
    if (!enabled()) return;
    closing = false;
    connect();
    pruneTimer = setInterval(pruneStale, PRUNE_INTERVAL_MS);
  }

  function stop(): void {
    closing = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    reconnectTimer = null;
    pruneTimer = null;
    if (ws) ws.close();
    ws = null;
  }

  onMounted(() => {
    watchEffect(() => {
      if (enabled()) {
        if (!ws) start();
      } else {
        stop();
      }
    });
  });
  onUnmounted(stop);

  return state;
}
