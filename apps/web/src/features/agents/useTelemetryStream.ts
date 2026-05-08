import { useEffect, useRef, useState } from "react";
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
  /** Latest error groups keyed by group id. Updated by error_group_updated events. */
  errorGroups: Record<string, ErrorGroup>;
  /** True once the WS has connected at least once. */
  connected: boolean;
};

const INITIAL: LiveTelemetry = { host: {}, apps: {}, presence: {}, errorGroups: {}, connected: false };

/** Entries older than this are pruned; matches ~3x the agent's 10s sampling cadence. */
const STALE_MS = 30_000;
const PRUNE_INTERVAL_MS = 5_000;

/**
 * Maintains a live view of host + app telemetry pushed from `/api/v1/realtime/ui`.
 * Auto-reconnects with exponential backoff on disconnect.
 */
export function useTelemetryStream(enabled = true): LiveTelemetry {
  const [state, setState] = useState<LiveTelemetry>(INITIAL);
  const closingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    closingRef.current = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      try {
        ws = openTelemetryStream();
      } catch (err) {
        console.error("[telemetry] failed to open WS", err);
        scheduleReconnect();
        return;
      }

      ws.addEventListener("open", () => {
        attempt = 0;
        setState((prev) => ({ ...prev, connected: true }));
      });

      ws.addEventListener("message", (ev) => {
        let parsed: UiTelemetryEvent;
        try {
          parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as UiTelemetryEvent;
        } catch {
          return;
        }
        setState((prev) => applyEvent(prev, parsed));
      });

      ws.addEventListener("close", () => {
        setState((prev) => ({ ...prev, connected: false }));
        if (!closingRef.current) {
          scheduleReconnect();
        }
      });

      ws.addEventListener("error", () => {
        // close handler schedules the reconnect.
      });
    };

    const scheduleReconnect = () => {
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();

    const pruneTimer = setInterval(() => {
      setState((prev) => pruneStale(prev));
    }, PRUNE_INTERVAL_MS);

    return () => {
      closingRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(pruneTimer);
      if (ws) ws.close();
    };
  }, [enabled]);

  return state;
}

function pruneStale(prev: LiveTelemetry): LiveTelemetry {
  const now = Date.now();
  let changed = false;
  const nextHost: Record<string, AgentTelemetry> = {};
  for (const [agentId, t] of Object.entries(prev.host)) {
    if (now - new Date(t.ts).getTime() < STALE_MS) {
      nextHost[agentId] = t;
    } else {
      changed = true;
    }
  }
  const nextApps: Record<string, Record<string, AgentAppTelemetry>> = {};
  for (const [agentId, inner] of Object.entries(prev.apps)) {
    const keptInner: Record<string, AgentAppTelemetry> = {};
    for (const [cid, app] of Object.entries(inner)) {
      if (now - new Date(app.ts).getTime() < STALE_MS) {
        keptInner[cid] = app;
      } else {
        changed = true;
      }
    }
    if (Object.keys(keptInner).length > 0) {
      nextApps[agentId] = keptInner;
    } else if (Object.keys(inner).length > 0) {
      changed = true;
    }
  }
  if (!changed) return prev;
  return { ...prev, host: nextHost, apps: nextApps };
}

function applyEvent(prev: LiveTelemetry, evt: UiTelemetryEvent): LiveTelemetry {
  switch (evt.type) {
    case "host_stats": {
      return {
        ...prev,
        host: {
          ...prev.host,
          [evt.agentId]: { ...evt.stats } as AgentTelemetry
        }
      };
    }
    case "app_stats": {
      const prevApps = prev.apps[evt.agentId] ?? {};
      return {
        ...prev,
        apps: {
          ...prev.apps,
          [evt.agentId]: {
            ...prevApps,
            [evt.containerId]: {
              ...evt.stats,
              containerId: evt.containerId
            } as AgentAppTelemetry
          }
        }
      };
    }
    case "agent_presence": {
      if (!evt.websocketConnected) {
        // Agent gone — drop its apps so stale entries don't linger in the table.
        const { [evt.agentId]: _apps, ...restApps } = prev.apps;
        const { [evt.agentId]: _host, ...restHost } = prev.host;
        return {
          ...prev,
          host: restHost,
          apps: restApps,
          presence: {
            ...prev.presence,
            [evt.agentId]: false
          }
        };
      }
      return {
        ...prev,
        presence: {
          ...prev.presence,
          [evt.agentId]: evt.websocketConnected
        }
      };
    }
    case "app_gone": {
      const prevApps = prev.apps[evt.agentId];
      if (!prevApps) return prev;
      const { [evt.containerId]: _removed, ...rest } = prevApps;
      return {
        ...prev,
        apps: { ...prev.apps, [evt.agentId]: rest }
      };
    }
    case "error_group_updated": {
      return {
        ...prev,
        errorGroups: {
          ...prev.errorGroups,
          [evt.group.id]: evt.group
        }
      };
    }
    default:
      return prev;
  }
}
