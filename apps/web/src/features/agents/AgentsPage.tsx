import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronRight, Cpu, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { api, type Agent, type AgentAppTelemetry, type AgentTelemetry, type MonitoredService } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { useTelemetryStream } from "./useTelemetryStream.js";
import { ErrorGroupsSection } from "./ErrorGroupsSection.js";

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

function formatBytes(n: number | undefined): string {
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

function formatBytesPerSec(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${formatBytes(n)}/s`;
}

function formatPercent(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

function AppsTelemetryTable({ apps }: { apps: AgentAppTelemetry[] }) {
  if (apps.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
        No managed apps yet. Telemetry is only reported for apps the agent manages
        (Docker containers from sync_desired_state). Attach services to this agent
        or push a desired-state update to populate this table.
      </p>
    );
  }
  const sorted = [...apps].sort((a, b) => {
    const nameA = a.name ?? a.containerId;
    const nameB = b.name ?? b.containerId;
    return nameA.localeCompare(nameB);
  });
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem", minWidth: 800 }}>
        <thead>
          <tr>
            <th style={thStyle}>Container</th>
            <th style={thStyle}>Image</th>
            <th style={thStyle}>State</th>
            <th style={thStyle}>CPU</th>
            <th style={thStyle}>Memory</th>
            <th style={thStyle}>Net RX</th>
            <th style={thStyle}>Net TX</th>
            <th style={thStyle}>Sampled</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((app) => (
            <tr key={app.containerId}>
              <td style={tdStyle}>
                <div style={{ fontWeight: 600 }}>{app.name ?? app.containerId.slice(0, 12)}</div>
                <div style={{ fontSize: "0.7rem", color: "var(--color-text-secondary)", fontFamily: "ui-monospace, monospace" }}>
                  {app.containerId.slice(0, 12)}
                </div>
              </td>
              <td style={{ ...tdStyle, fontSize: "0.75rem" }} title={app.image}>
                {app.image ? app.image.split("@")[0] : "—"}
              </td>
              <td style={tdStyle}>
                <Badge variant={app.state === "running" ? "success" : "muted"}>{app.state ?? "—"}</Badge>
              </td>
              <td style={tdStyle}>{formatPercent(app.cpuPercent)}</td>
              <td style={tdStyle}>
                {app.memPercent !== undefined ? (
                  <>
                    <div>{formatPercent(app.memPercent)}</div>
                    {app.memUsedBytes !== undefined && app.memLimitBytes !== undefined ? (
                      <div style={{ fontSize: "0.7rem", color: "var(--color-text-secondary)" }}>
                        {formatBytes(app.memUsedBytes)} / {formatBytes(app.memLimitBytes)}
                      </div>
                    ) : null}
                  </>
                ) : app.memUsedBytes !== undefined ? (
                  formatBytes(app.memUsedBytes)
                ) : (
                  "—"
                )}
              </td>
              <td style={tdStyle}>{formatBytesPerSec(app.netRxBytesPerSec)}</td>
              <td style={tdStyle}>{formatBytesPerSec(app.netTxBytesPerSec)}</td>
              <td style={{ ...tdStyle, fontSize: "0.7rem", color: "var(--color-text-secondary)" }}>
                {new Date(app.ts).toLocaleTimeString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const live = useTelemetryStream(true);

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

  /** Merge REST snapshot with live WS updates so telemetry stays fresh between polls. */
  const displayedAgents = useMemo<Agent[]>(() => {
    return agents.map((a) => {
      const liveHost = live.host[a.id];
      const liveApps = live.apps[a.id];
      const livePresence = live.presence[a.id];
      const apps: AgentAppTelemetry[] = liveApps
        ? Object.values(liveApps)
        : a.apps ?? [];
      const telemetry: AgentTelemetry | undefined = liveHost ?? a.telemetry;
      return {
        ...a,
        ...(telemetry ? { telemetry } : {}),
        ...(apps.length > 0 ? { apps } : {}),
        websocketConnected:
          livePresence !== undefined ? livePresence : a.websocketConnected
      };
    });
  }, [agents, live]);

  const summary = useMemo(() => {
    let liveWs = 0;
    const byStatus: Record<string, number> = { online: 0, degraded: 0, offline: 0, unknown: 0 };
    for (const a of displayedAgents) {
      if (a.websocketConnected) liveWs += 1;
      const k = a.status in byStatus ? a.status : "unknown";
      byStatus[k] = (byStatus[k] ?? 0) + 1;
    }
    return { liveWs, byStatus };
  }, [displayedAgents]);

  const startEdit = useCallback((a: Agent) => {
    setEditingId(a.id);
    setEditName(a.name ?? "");
    setActionError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditName("");
  }, []);

  const saveEdit = useCallback(
    async (agentId: string) => {
      const trimmed = editName.trim();
      setSavingId(agentId);
      setActionError(null);
      try {
        await api.updateAgent(agentId, { name: trimmed === "" ? null : trimmed });
        setEditingId(null);
        setEditName("");
        await fetchData();
      } catch (e: unknown) {
        setActionError((e as Error).message);
      } finally {
        setSavingId(null);
      }
    },
    [editName, fetchData]
  );

  const deleteAgent = useCallback(
    async (agentId: string, displayName: string) => {
      if (!window.confirm(`Remove agent "${displayName}"? Any services bound to it will be detached.`)) {
        return;
      }
      setSavingId(agentId);
      setActionError(null);
      try {
        await api.deleteAgent(agentId);
        await fetchData();
      } catch (e: unknown) {
        setActionError((e as Error).message);
      } finally {
        setSavingId(null);
      }
    },
    [fetchData]
  );

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Connected Agents</h2>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Badge variant={live.connected ? "success" : "muted"}>
            {live.connected ? "Live stream" : "Reconnecting…"}
          </Badge>
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
      {actionError && (
        <div style={{ color: "var(--color-danger)", marginBottom: "0.75rem" }} role="alert">
          {actionError}
        </div>
      )}

      {loading && (
        <p style={{ color: "var(--color-text-secondary)", margin: "0 0 1rem" }}>Loading…</p>
      )}

      {!loading && !error && displayedAgents.length > 0 && (
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
            <strong style={{ color: "var(--color-text-primary)" }}>{displayedAgents.length}</strong> agent{displayedAgents.length === 1 ? "" : "s"}
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

      {!loading && !error && displayedAgents.length === 0 ? (
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

      {!loading && !error && displayedAgents.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
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
                  CPU
                </th>
                <th scope="col" style={thStyle}>
                  Memory
                </th>
                <th scope="col" style={thStyle}>
                  Disk
                </th>
                <th scope="col" style={thStyle}>
                  Net RX
                </th>
                <th scope="col" style={thStyle}>
                  Net TX
                </th>
                <th scope="col" style={thStyle}>
                  Process RSS
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
                {!isViewer && (
                  <th scope="col" style={thStyle}>
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {displayedAgents.map((a) => {
                const svc = serviceInfoByAgent.get(a.id);
                const svcCount = svc?.count ?? 0;
                const displayName = a.name?.trim() || a.id;
                const badgeVariant = AGENT_STATUS_BADGE[a.status] ?? "muted";
                const isLive = a.websocketConnected === true;
                const isEditing = editingId === a.id;
                const isSaving = savingId === a.id;
                const appsList = a.apps ?? [];
                const isExpanded = expanded[a.id] === true;
                const toggleExpanded = () =>
                  setExpanded((prev) => ({ ...prev, [a.id]: !prev[a.id] }));
                return (
                  <Fragment key={a.id}>
                  <tr>
                    <td style={tdStyle}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                        <button
                          type="button"
                          onClick={toggleExpanded}
                          aria-label={isExpanded ? "Collapse apps" : "Expand apps"}
                          aria-expanded={isExpanded}
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                            color: "var(--color-text-secondary)",
                            display: "inline-flex"
                          }}
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <Cpu size={14} aria-hidden />
                        {isEditing ? (
                          <input
                            aria-label={`Rename agent ${a.id}`}
                            value={editName}
                            onChange={(ev) => setEditName(ev.target.value)}
                            disabled={isSaving}
                            style={{
                              padding: "0.25rem 0.4rem",
                              fontSize: "0.85rem",
                              background: "var(--color-surface)",
                              color: "var(--color-text-primary)",
                              border: "1px solid var(--color-border)",
                              borderRadius: 4,
                              minWidth: 180
                            }}
                          />
                        ) : (
                          <span>
                            <span style={{ fontWeight: 600 }}>{displayName}</span>
                            {a.name?.trim() ? (
                              <div style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)" }}>{a.id}</div>
                            ) : null}
                            {appsList.length > 0 ? (
                              <div style={{ fontSize: "0.72rem", color: "var(--color-text-secondary)" }}>
                                {appsList.length} app{appsList.length === 1 ? "" : "s"}
                              </div>
                            ) : null}
                          </span>
                        )}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <Badge variant={isLive ? "success" : "muted"}>{isLive ? "Yes" : "No"}</Badge>
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
                    <td
                      style={{ ...tdStyle, fontSize: "0.85rem" }}
                      title={a.telemetry ? `Sampled ${new Date(a.telemetry.ts).toLocaleString()}` : undefined}
                    >
                      {formatPercent(a.telemetry?.cpuPercent)}
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.85rem" }}>
                      {a.telemetry?.memPercent !== undefined ? (
                        <>
                          <div>{formatPercent(a.telemetry.memPercent)}</div>
                          {a.telemetry.memUsedBytes !== undefined && a.telemetry.memTotalBytes !== undefined ? (
                            <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
                              {formatBytes(a.telemetry.memUsedBytes)} / {formatBytes(a.telemetry.memTotalBytes)}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      style={{ ...tdStyle, fontSize: "0.85rem" }}
                      title={a.telemetry?.diskPath}
                    >
                      {a.telemetry?.diskUsedBytes !== undefined && a.telemetry?.diskTotalBytes !== undefined ? (
                        <>
                          <div>
                            {formatPercent((a.telemetry.diskUsedBytes / a.telemetry.diskTotalBytes) * 100)}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
                            {formatBytes(a.telemetry.diskUsedBytes)} / {formatBytes(a.telemetry.diskTotalBytes)}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.85rem" }}>
                      {formatBytesPerSec(a.telemetry?.netRxBytesPerSec)}
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.85rem" }}>
                      {formatBytesPerSec(a.telemetry?.netTxBytesPerSec)}
                    </td>
                    <td style={{ ...tdStyle, fontSize: "0.85rem" }}>
                      {formatBytes(a.telemetry?.processRSSBytes)}
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
                    {!isViewer && (
                      <td style={{ ...tdStyle, fontSize: "0.85rem" }}>
                        {isEditing ? (
                          <span style={{ display: "inline-flex", gap: "0.35rem" }}>
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => void saveEdit(a.id)}
                              disabled={isSaving}
                              aria-label={`Save name for agent ${a.id}`}
                            >
                              <Check size={14} /> Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={cancelEdit}
                              disabled={isSaving}
                              aria-label={`Cancel rename for agent ${a.id}`}
                            >
                              <X size={14} /> Cancel
                            </Button>
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: "0.35rem" }}>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => startEdit(a)}
                              disabled={isSaving}
                              aria-label={`Rename agent ${a.id}`}
                            >
                              <Pencil size={14} /> Rename
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void deleteAgent(a.id, displayName)}
                              disabled={isSaving}
                              aria-label={`Remove agent ${a.id}`}
                            >
                              <Trash2 size={14} /> Remove
                            </Button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                  {isExpanded ? (
                    <tr>
                      <td colSpan={14} style={{ ...tdStyle, padding: "0.25rem 0.5rem 1rem 2rem", background: "var(--color-surface-muted, transparent)" }}>
                        <AppsTelemetryTable apps={appsList} />
                        <div style={{ marginTop: "1rem" }}>
                          <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.9rem", color: "var(--color-text-secondary)" }}>
                            Error groups (auto-fix)
                          </h3>
                          <ErrorGroupsSection agentId={a.id} liveGroups={live.errorGroups} />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
