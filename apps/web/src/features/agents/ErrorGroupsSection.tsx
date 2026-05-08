import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { AlertTriangle, KeyRound, Loader2, ShieldCheck, Pause } from "lucide-react";
import { api, type ErrorGroup, type ErrorGroupStatus } from "../../lib/api.js";
import { Badge } from "../../components/Badge.js";

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.78rem",
  fontWeight: 600
};

const tdStyle: CSSProperties = { padding: "0.5rem", verticalAlign: "top", fontSize: "0.85rem" };

const STATUS_BADGE: Record<ErrorGroupStatus, "success" | "warning" | "danger" | "muted" | "info"> = {
  open: "warning",
  fixing: "info",
  fixed: "success",
  paused: "danger",
  missing_auth: "danger"
};

const STATUS_ICON: Record<ErrorGroupStatus, ReactElement> = {
  open: <AlertTriangle size={12} />,
  fixing: <Loader2 size={12} className="spin" />,
  fixed: <ShieldCheck size={12} />,
  paused: <Pause size={12} />,
  missing_auth: <KeyRound size={12} />
};

const STATUS_HINT: Record<ErrorGroupStatus, string> = {
  open: "Detected. Awaiting auto-fix dispatch.",
  fixing: "A claude session is rewriting the repo and will push to main.",
  fixed: "Fix pushed. Watching for re-occurrence within 30 minutes.",
  paused: "Same error reappeared shortly after a fix — auto-fix paused. Investigate manually.",
  missing_auth: "Service has no SSH key. Add one in Services to enable auto-fix."
};

function formatRelativeTime(iso: string | null | undefined): string {
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

export function ErrorGroupsSection({
  agentId,
  liveGroups
}: {
  agentId: string;
  liveGroups: Record<string, ErrorGroup>;
}) {
  const [snapshot, setSnapshot] = useState<ErrorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .listErrorGroupsForAgent(agentId)
      .then((r) => setSnapshot(r.groups))
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [agentId]);

  const merged = useMemo(() => {
    const byId = new Map<string, ErrorGroup>();
    for (const g of snapshot) byId.set(g.id, g);
    // live updates win — they reflect the current status (fixing/fixed/paused).
    for (const g of Object.values(liveGroups)) {
      if (g.agentId === agentId) byId.set(g.id, g);
    }
    return [...byId.values()].sort(
      (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
    );
  }, [snapshot, liveGroups, agentId]);

  if (loading) {
    return <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>Loading error groups…</p>;
  }
  if (error) {
    return <p style={{ margin: 0, color: "var(--color-danger)", fontSize: "0.8rem" }}>{error}</p>;
  }
  if (merged.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
        No error groups for this agent. Auto-fix triggers when a managed app emits an error log
        and the service has an SSH key configured for git push.
      </p>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem", minWidth: 800 }}>
        <thead>
          <tr>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Service</th>
            <th style={thStyle}>Error</th>
            <th style={thStyle}>Count</th>
            <th style={thStyle}>Last seen</th>
            <th style={thStyle}>Last fix</th>
          </tr>
        </thead>
        <tbody>
          {merged.map((g) => (
            <tr key={g.id}>
              <td style={tdStyle}>
                <span title={STATUS_HINT[g.status]} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                  <Badge variant={STATUS_BADGE[g.status] ?? "muted"}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem" }}>
                      {STATUS_ICON[g.status]} {g.status.replace("_", " ")}
                    </span>
                  </Badge>
                </span>
              </td>
              <td style={{ ...tdStyle, fontFamily: "ui-monospace, monospace" }}>{g.serviceId}</td>
              <td style={tdStyle}>
                <div style={{ fontWeight: 500 }}>{g.sampleMessage}</div>
                <div style={{ fontSize: "0.7rem", color: "var(--color-text-secondary)", fontFamily: "ui-monospace, monospace" }}>
                  {g.fingerprint}
                </div>
                {g.status === "missing_auth" ? (
                  <div style={{ marginTop: 4, color: "var(--color-danger)", fontSize: "0.75rem" }}>
                    Auto-fix disabled: this service has no SSH key. Configure one in Services.
                  </div>
                ) : null}
                {g.status === "paused" ? (
                  <div style={{ marginTop: 4, color: "var(--color-danger)", fontSize: "0.75rem" }}>
                    A previous fix did not stop this error. Auto-fix paused to avoid a loop.
                  </div>
                ) : null}
              </td>
              <td style={tdStyle}>{g.count}</td>
              <td style={tdStyle}>{formatRelativeTime(g.lastSeenAt)}</td>
              <td style={tdStyle}>
                {g.lastFixAt ? (
                  <>
                    <div>{formatRelativeTime(g.lastFixAt)}</div>
                    {g.lastFixCommit ? (
                      <div
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--color-text-secondary)",
                          fontFamily: "ui-monospace, monospace"
                        }}
                      >
                        {g.lastFixCommit.slice(0, 12)}
                      </div>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
