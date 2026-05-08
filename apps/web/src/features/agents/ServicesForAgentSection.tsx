import { useMemo, useState, type CSSProperties } from "react";
import { api, type MonitoredService } from "../../lib/api.js";

const cellStyle: CSSProperties = { padding: "0.5rem", verticalAlign: "top", fontSize: "0.85rem" };
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.78rem",
  fontWeight: 600
};

const subhead: CSSProperties = { margin: "0 0 0.5rem", fontSize: "0.85rem", color: "var(--color-text-secondary)" };

const btn = (variant: "primary" | "muted" | "danger" = "muted"): CSSProperties => {
  const base: CSSProperties = {
    border: "1px solid var(--color-border)",
    borderRadius: 4,
    padding: "0.2rem 0.55rem",
    cursor: "pointer",
    fontSize: "0.78rem"
  };
  if (variant === "primary") {
    return { ...base, background: "var(--color-primary)", color: "var(--color-primary-foreground)", borderColor: "var(--color-primary)" };
  }
  if (variant === "danger") {
    return { ...base, background: "var(--color-surface)", color: "var(--color-danger)" };
  }
  return { ...base, background: "var(--color-surface)", color: "var(--color-text-primary)" };
};

/**
 * Per-agent services subsection for the AgentsPage row. Shows currently-bound
 * services with a Detach button and a "+ Bind" picker for unbound ones.
 *
 * Editing is non-destructive — the data layer enforces that the same service
 * can be bound to multiple agents simultaneously, so attach/detach calls
 * never affect the service's bindings on _other_ agents.
 */
export function ServicesForAgentSection({
  agentId,
  allServices,
  onChange,
  disabled
}: {
  agentId: string;
  /** All services in the tenant (the AgentsPage already loads these). */
  allServices: MonitoredService[];
  /** Called after a successful attach/detach so the parent can refetch services. */
  onChange: () => void;
  /** When true (e.g. viewer role), all controls are read-only. */
  disabled?: boolean;
}) {
  const [pickerValue, setPickerValue] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null); // serviceId being mutated
  const [error, setError] = useState<string | null>(null);

  const bound = useMemo(
    () => allServices.filter((s) => s.agents?.some((a) => a.agentId === agentId)),
    [allServices, agentId]
  );
  const unbound = useMemo(
    () => allServices.filter((s) => !s.agents?.some((a) => a.agentId === agentId)),
    [allServices, agentId]
  );

  async function handleAttach() {
    if (!pickerValue) return;
    setError(null);
    setBusy(pickerValue);
    try {
      await api.attachServiceToAgent(agentId, pickerValue);
      setPickerValue("");
      onChange();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleDetach(serviceId: string) {
    setError(null);
    setBusy(serviceId);
    try {
      await api.detachServiceFromAgent(agentId, serviceId);
      onChange();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ marginTop: "0.75rem" }}>
      <h4 style={subhead}>Services bound to this agent</h4>

      {error && (
        <div role="alert" style={{ color: "var(--color-danger)", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          {error}
        </div>
      )}

      {bound.length === 0 ? (
        <p style={{ color: "var(--color-text-secondary)", fontSize: "0.82rem", margin: "0 0 0.5rem" }}>
          No services bound. Pick one below to attach.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.5rem" }}>
          <thead>
            <tr>
              <th style={thStyle}>Service</th>
              <th style={thStyle}>Repo</th>
              <th style={thStyle}>Branch</th>
              {!disabled && <th style={thStyle}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {bound.map((svc) => (
              <tr key={svc.id}>
                <td style={cellStyle}>{svc.name}</td>
                <td style={cellStyle}>{svc.gitRepoUrl}</td>
                <td style={cellStyle}>{svc.branch}</td>
                {!disabled && (
                  <td style={cellStyle}>
                    <button
                      type="button"
                      onClick={() => void handleDetach(svc.id)}
                      disabled={busy === svc.id}
                      style={btn("danger")}
                    >
                      {busy === svc.id ? "Detaching…" : "Detach"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!disabled && (
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
          <select
            aria-label="Pick a service to bind to this agent"
            value={pickerValue}
            onChange={(e) => setPickerValue(e.target.value)}
            disabled={unbound.length === 0}
            style={{
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text-primary)",
              borderRadius: 4,
              padding: "0.2rem 0.4rem",
              fontSize: "0.82rem",
              minWidth: 220
            }}
          >
            <option value="">
              {unbound.length === 0 ? "All services already bound" : "— pick a service —"}
            </option>
            {unbound.map((svc) => (
              <option key={svc.id} value={svc.id}>
                {svc.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleAttach()}
            disabled={!pickerValue || busy !== null}
            style={btn("primary")}
          >
            + Bind
          </button>
        </div>
      )}
    </section>
  );
}
