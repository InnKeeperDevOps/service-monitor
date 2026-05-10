// Stale-while-revalidate cache for the Agent Detail page.
//
// Goal: when the user navigates back to /#agent/<id>, the page should
// render the last-known state immediately while a fresh fetch runs in
// the background. The cache lives in sessionStorage so it survives
// refreshes within the tab session but doesn't leak across sessions
// (avoiding stale data after re-login or a long absence).
//
// Stored shape per-agent:
//   agent:                last Agent record returned by listAgents/getAgent
//   services:             tenant-wide MonitoredService list (cached at the
//                         tenant key, mirrored here so detail page only
//                         reads one entry)
//   running:              latest /agents/:id/running-services snapshot
//   hostTelemetry:        last host_stats frame (host CPU/mem/disk/net/RSS)
//   hostTelemetrySampledAt: client-side ms timestamp of when telemetry
//                         was captured, so we can show "(stale 30s ago)"
//                         when the agent goes silent
//   updatedAt:            wall-clock ms of the last write — only used
//                         to drop entries that are >24h old on read

import type { Agent, AgentTelemetry, MonitoredService } from "../../lib/api.js";

export type RunningEntry = {
  serviceId: string;
  environment: string;
  namespace: string;
  imageRef: string | null;
  buildId: string | null;
  observedAt: string;
};

export type CachedAgentDetail = {
  agent: Agent | null;
  services: MonitoredService[];
  running: RunningEntry[];
  hostTelemetry: AgentTelemetry | null;
  hostTelemetrySampledAt: number | null;
  updatedAt: number;
};

const KEY_PREFIX = "kaiad:agentDetail:";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function emptyEntry(): CachedAgentDetail {
  return {
    agent: null,
    services: [],
    running: [],
    hostTelemetry: null,
    hostTelemetrySampledAt: null,
    updatedAt: 0
  };
}

function safeStorage(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function readCachedAgentDetail(agentId: string): CachedAgentDetail | null {
  const ss = safeStorage();
  if (!ss) return null;
  try {
    const raw = ss.getItem(KEY_PREFIX + agentId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAgentDetail;
    if (Date.now() - parsed.updatedAt > MAX_AGE_MS) {
      ss.removeItem(KEY_PREFIX + agentId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedAgentDetail(agentId: string, patch: Partial<CachedAgentDetail>): void {
  const ss = safeStorage();
  if (!ss) return;
  const existing = readCachedAgentDetail(agentId) ?? emptyEntry();
  const merged: CachedAgentDetail = {
    ...existing,
    ...patch,
    updatedAt: Date.now()
  };
  try {
    ss.setItem(KEY_PREFIX + agentId, JSON.stringify(merged));
  } catch {
    // quota / serialization — drop silently; cache is best-effort
  }
}

/** Forget a specific agent — useful after delete. */
export function clearCachedAgentDetail(agentId: string): void {
  const ss = safeStorage();
  if (!ss) return;
  try {
    ss.removeItem(KEY_PREFIX + agentId);
  } catch {
    /* ignore */
  }
}
