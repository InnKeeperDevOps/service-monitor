import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Clock } from "lucide-react";
import { api, type Incident } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

const statusIcon: Record<string, typeof AlertTriangle> = {
  open: AlertTriangle,
  acknowledged: Clock,
  resolved: CheckCircle,
  closed: CheckCircle
};

const statusColor: Record<string, string> = {
  open: "var(--color-danger)",
  acknowledged: "var(--color-warning)",
  resolved: "var(--color-success)",
  closed: "var(--color-text-secondary)"
};

export function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { isViewer } = useAuth();

  useEffect(() => {
    api.listIncidents().then((r) => setIncidents(r.incidents)).catch((e) => setError(e.message));
  }, []);

  async function handleStatusChange(id: string, status: string) {
    try {
      const updated = await api.updateIncidentStatus(id, status);
      setIncidents((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  const headers = isViewer
    ? ["Status", "Message", "Fingerprint", "Service", "First Seen", "Events"]
    : ["Status", "Message", "Fingerprint", "Service", "First Seen", "Events", "Actions"];

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem" }}>Incidents</h2>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: "0.5rem" }}>{error}</div>}
      {incidents.length === 0 ? (
        <p style={{ color: "var(--color-text-secondary)" }}>No incidents recorded yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "0.5rem", borderBottom: "2px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {incidents.map((inc) => {
              const Icon = statusIcon[inc.status] ?? AlertTriangle;
              const isExpanded = expandedId === inc.id;
              return (
                <IncidentRow
                  key={inc.id}
                  inc={inc}
                  Icon={Icon}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedId(isExpanded ? null : inc.id)}
                  onStatusChange={handleStatusChange}
                  hideActions={isViewer}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function IncidentRow({
  inc,
  Icon,
  isExpanded,
  onToggle,
  onStatusChange,
  hideActions,
}: {
  inc: Incident;
  Icon: typeof AlertTriangle;
  isExpanded: boolean;
  onToggle: () => void;
  onStatusChange: (id: string, status: string) => void;
  hideActions: boolean;
}) {
  const colSpan = hideActions ? 6 : 7;
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }}>
        <td style={{ padding: "0.5rem" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: statusColor[inc.status] }}>
            <Icon size={14} /> {inc.status}
          </span>
        </td>
        <td style={{ padding: "0.5rem", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {inc.message ?? inc.fingerprint.slice(0, 16)}
        </td>
        <td style={{ padding: "0.5rem", fontSize: "0.8rem", fontFamily: "monospace", color: "var(--color-text-secondary)" }}>
          {inc.fingerprint.slice(0, 12)}…
        </td>
        <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>{inc.serviceId}</td>
        <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>{new Date(inc.firstSeenAt).toLocaleString()}</td>
        <td style={{ padding: "0.5rem", textAlign: "center" }}>{inc.eventCount}</td>
        {!hideActions && (
          <td style={{ padding: "0.5rem" }} onClick={(e) => e.stopPropagation()}>
            {inc.status === "open" && (
              <button onClick={() => onStatusChange(inc.id, "acknowledged")} style={btnStyle}>Acknowledge</button>
            )}
            {(inc.status === "open" || inc.status === "acknowledged") && (
              <button onClick={() => onStatusChange(inc.id, "resolved")} style={{ ...btnStyle, marginLeft: "0.25rem" }}>Resolve</button>
            )}
          </td>
        )}
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={colSpan} style={{ padding: "0.75rem 1rem", background: "var(--color-surface-muted)", borderBottom: "2px solid var(--color-border)" }}>
            <div style={{ display: "grid", gap: "0.5rem", fontSize: "0.85rem" }}>
              <div>
                <strong>Fingerprint:</strong>{" "}
                <code style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>{inc.fingerprint}</code>
              </div>
              <div>
                <strong>Timeline:</strong>{" "}
                First seen {new Date(inc.firstSeenAt).toLocaleString()}{" · "}
                Last seen {new Date(inc.lastSeenAt).toLocaleString()}{" · "}
                {inc.eventCount} event{inc.eventCount !== 1 ? "s" : ""}
              </div>
              <div style={{ display: "flex", gap: "1rem" }}>
                <a href="#workflows" style={{ color: "var(--color-primary)", textDecoration: "none", fontWeight: 500 }}>
                  View Workflow →
                </a>
                <a href="#settings" style={{ color: "var(--color-primary)", textDecoration: "none", fontWeight: 500 }}>
                  Review GitHub Policy →
                </a>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const btnStyle: React.CSSProperties = {
  background: "var(--color-primary)",
  color: "var(--color-primary-foreground)",
  border: "none",
  borderRadius: 6,
  padding: "0.25rem 0.5rem",
  fontSize: "0.8rem",
  cursor: "pointer"
};
