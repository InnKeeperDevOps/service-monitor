// Formatting helpers shared across the agents list and detail pages.

export const AGENT_STATUS_BADGE: Record<string, "success" | "warning" | "danger" | "muted"> = {
  online: "success",
  degraded: "warning",
  offline: "danger",
  unknown: "muted"
};

/**
 * Display label for an agent runtime. Null/undefined indicates the
 * agent hasn't reported one yet (pre-upgrade or just-enrolled), so
 * the UI shows "unknown" instead of guessing.
 */
export function formatRuntimeBackend(rt: string | null | undefined): string {
  if (rt == null || rt === "") return "unknown";
  if (rt === "kubernetes") return "k8s";
  return rt;
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function truncateFingerprint(fp: string | null | undefined, max = 18): string {
  if (fp == null || fp === "") return "—";
  if (fp.length <= max) return fp;
  return `${fp.slice(0, max)}…`;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const precision = v >= 100 || i === 0 ? 0 : 1;
  return `${v.toFixed(precision)} ${units[i]}`;
}

export function formatBytesPerSec(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${formatBytes(n)}/s`;
}

export function formatPercent(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

export function badgeVariantForStatus(status: string): "success" | "warning" | "danger" | "muted" {
  return AGENT_STATUS_BADGE[status] ?? "muted";
}
