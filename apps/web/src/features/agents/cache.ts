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

/** One host_stats sample. Sparse — fields the agent didn't report stay undefined. */
export type TelemetrySample = {
  /** Client receive time (ms). Used for x-axis spacing and ring-buffer order. */
  ts: number;
  cpuPercent?: number;
  memPercent?: number;
  diskPercent?: number;
  netRxBytesPerSec?: number;
  netTxBytesPerSec?: number;
  processRSSBytes?: number;
};

/** Cap on retained samples — at one frame per ~5s that's ~10 minutes of history. */
export const TELEMETRY_RING_CAP = 120;

export type CachedAgentDetail = {
  agent: Agent | null;
  services: MonitoredService[];
  running: RunningEntry[];
  hostTelemetry: AgentTelemetry | null;
  hostTelemetrySampledAt: number | null;
  /** Ring buffer of host_stats samples; oldest first, newest last. */
  telemetrySamples: TelemetrySample[];
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
    telemetrySamples: [],
    updatedAt: 0
  };
}

/**
 * Append one telemetry sample to the ring buffer + persist. Capped at
 * TELEMETRY_RING_CAP; oldest entries fall off. Skips writes when the
 * sample looks identical to the last (same `cpuPercent` etc) to avoid
 * burning sessionStorage on duplicate frames the WS may emit when
 * nothing changed.
 */
export function appendTelemetrySample(agentId: string, sample: TelemetrySample): TelemetrySample[] {
  const existing = readCachedAgentDetail(agentId) ?? emptyEntry();
  const last = existing.telemetrySamples[existing.telemetrySamples.length - 1];
  if (last && telemetrySampleEqual(last, sample)) {
    return existing.telemetrySamples;
  }
  const next = [...existing.telemetrySamples, sample];
  if (next.length > TELEMETRY_RING_CAP) {
    next.splice(0, next.length - TELEMETRY_RING_CAP);
  }
  writeCachedAgentDetail(agentId, { telemetrySamples: next });
  return next;
}

function telemetrySampleEqual(a: TelemetrySample, b: TelemetrySample): boolean {
  return (
    a.cpuPercent === b.cpuPercent &&
    a.memPercent === b.memPercent &&
    a.diskPercent === b.diskPercent &&
    a.netRxBytesPerSec === b.netRxBytesPerSec &&
    a.netTxBytesPerSec === b.netTxBytesPerSec &&
    a.processRSSBytes === b.processRSSBytes
  );
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
