import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Cpu, RefreshCw } from "lucide-react";
import { api, type Agent, type MonitoredService } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";

const POLL_INTERVAL_MS = 30_000;

const AGENT_STATUS_BADGE: Record<string, "success" | "warning" | "danger" | "muted"> = {
  online: "success",
  degraded: "warning",
  offline: "danger",
  unknown: "muted"
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.8rem",
  fontWeight: 600
};

const tdStyle: CSSProperties = { padding: "0.5rem", verticalAlign: "top" };

function formatRelativeTime(iso: string | null): string {
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

function truncateFingerprint(fp: string | null | undefined, max = 18): string {
  if (fp == null || fp === "") return "—";
  if (fp.length <= max) return fp;
  return `${fp.slice(0, max)}…`;
}

function buildServiceCounts(services: MonitoredService[]): Map<string, { count: number; names: string[] }> {
  const m = new Map<string, { count: number; names: string[] }>();
  for (const s of services) {
    if (!s.agentId) continue;
    const cur = m.get(s.agentId) ?? { count: 0, names: [] };
    cur.count += 1;
    cur.names.push(s.name);
    m.set(s.agentId, cur);
  }
  return m;
}

export function AgentsPage() {
  const { isViewer } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);

  const fetchData = useCallback(() => {
    setError(null);
    return Promise.all([api.listAgents(), api.listServices()])
      .then(([ar, sr]) => {
        setAgents(ar.agents);
        setServices(sr.services);
        setLastUpdated(new Date());
      })
      .catch((e: unknown) => {
        setError((e as Error).message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    const id = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  useEffect(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const serviceInfoByAgent = useMemo(() => buildServiceCounts(services), [services]);

  const summary = useMemo(() => {
    let liveWs = 0;
    const byStatus: Record<string, number> = { online: 0, degraded: 0, offline: 0, unknown: 0 };
    for (const a of agents) {
      if (a.websocketConnected) liveWs += 1;
      const k = a.status in byStatus ? a.status : "unknown";
      byStatus[k] = (byStatus[k] ?? 0) + 1;
    }
    return { liveWs, byStatus };
  }, [agents]);

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Connected Agents</h2>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {lastUpdated && (
            <span style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
              Last updated: {secondsAgo}s ago
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => void fetchData()} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div style={{ color: "var(--color-danger)", marginBottom: "0.75rem" }} role="alert">
          {error}
        </div>
      )}

      {loading && (
        <p style={{ color: "var(--color-text-secondary)", margin: "0 0 1rem" }}>Loading…</p>
      )}

      {!loading && !error && agents.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            alignItems: "center",
            marginBottom: "1rem",
            fontSize: "0.85rem",
            color: "var(--color-text-secondary)"
          }}
        >
          <span>
            <strong style={{ color: "var(--color-text-primary)" }}>{agents.length}</strong> agent{agents.length === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <strong style={{ color: "var(--color-text-primary)" }}>{summary.liveWs}</strong> live (WebSocket)
          </span>
          {(["online", "degraded", "offline", "unknown"] as const).map((st) =>
            summary.byStatus[st] > 0 ? (
              <Badge key={st} variant={AGENT_STATUS_BADGE[st] ?? "muted"}>
                {st}: {summary.byStatus[st]}
              </Badge>
            ) : null
          )}
        </div>
      )}

      {!loading && !error && agents.length === 0 ? (
        <p style={{ color: "var(--color-text-secondary)", margin: 0 }}>
          No agents connected.{" "}
          {isViewer ? (
            <>Ask an administrator to create an enrollment token.</>
          ) : (
            <>
              Create an enrollment token in{" "}
              <a href="#settings" style={{ color: "var(--color-primary)" }}>
                Settings
              </a>{" "}
              to register an agent.
            </>
          )}
        </p>
      ) : null}

      {!loading && !error && agents.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  Agent
                </th>
                <th scope="col" style={thStyle}>
                  Live
                </th>
                <th scope="col" style={thStyle}>
                  Status
                </th>
                <th scope="col" style={thStyle}>
                  Version
                </th>
                <th scope="col" style={thStyle}>
                  Last seen
                </th>
                <th scope="col" style={thStyle}>
                  Capabilities
                </th>
                <th scope="col" style={thStyle}>
                  Certificate
                </th>
                <th scope="col" style={thStyle}>
                  Services
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const svc = serviceInfoByAgent.get(a.id);
                const svcCount = svc?.count ?? 0;
                const displayName = a.name?.trim() || a.id;
                const badgeVariant = AGENT_STATUS_BADGE[a.status] ?? "muted";
                const live = a.websocketConnected === true;
                return (
                  <tr key={a.id}>
                    <td style={tdStyle}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                        <Cpu size={14} aria-hidden />
                        <span>
                          <span style={{ fontWeight: 600 }}>{displayName}</span>
                          {a.name?.trim() ? (
                            <div style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)" }}>{a.id}</div>
                          ) : null}
                        </span>
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <Badge variant={live ? "success" : "muted"}>{live ? "Yes" : "No"}</Badge>
                    </td>
                    <td style={tdStyle}>
                      <Badge variant={badgeVariant}>{a.status}</Badge>
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.85rem" }}>{a.version ?? "—"}</td>
                    <td style={tdStyle}>
                      <span title={a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString() : undefined}>
                        {formatRelativeTime(a.lastSeenAt)}
                      </span>
                      {a.lastSeenAt ? (
                        <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
                          {new Date(a.lastSeenAt).toLocaleString()}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.8rem", maxWidth: 200 }}>
                      {a.allowedCapabilities && a.allowedCapabilities.length > 0 ? (
                        <span title={a.allowedCapabilities.join(", ")}>{a.allowedCapabilities.join(", ")}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.78rem", fontFamily: "ui-monospace, monospace" }}>
                      <span title={a.certFingerprint ?? undefined}>{truncateFingerprint(a.certFingerprint ?? null)}</span>
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.85rem" }}>
                      {svcCount > 0 ? (
                        <a
                          href="#services"
                          style={{ color: "var(--color-primary)" }}
                          title={svc?.names.join(", ")}
                        >
                          {svcCount}
                        </a>
                      ) : (
                        "0"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
