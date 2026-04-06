import { Building2, Settings } from "lucide-react";
import { useAuth } from "../../lib/useAuth.js";

const muted: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: "0.85rem" };
const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.65rem 0",
  borderBottom: "1px solid var(--color-border)",
  fontSize: "0.9rem",
};

export function TenantsPage() {
  const { user } = useAuth();
  const memberships = user?.memberships ?? [];

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Building2 size={20} /> Tenants
      </h2>
      <p style={{ ...muted, marginBottom: "1rem" }}>
        Workspaces you belong to. Open configuration for repo defaults, automation policy, and executors.
      </p>
      {memberships.length === 0 ? (
        <p style={muted}>No tenant memberships.</p>
      ) : (
        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          <div
            style={{
              ...rowStyle,
              fontWeight: 600,
              color: "var(--color-text-secondary)",
              fontSize: "0.8rem",
              paddingTop: 0,
            }}
          >
            <span>Tenant</span>
            <span>Role</span>
            <span style={{ textAlign: "right" }}>Configure</span>
          </div>
          {memberships.map((m) => (
            <div key={m.tenantId} style={rowStyle}>
              <div>
                <div style={{ fontWeight: 600 }}>{m.tenantName}</div>
                <div style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--color-text-secondary)" }}>
                  {m.tenantId}
                </div>
              </div>
              <span>{m.role}</span>
              <div style={{ textAlign: "right" }}>
                <a
                  href={`#tenant-config/${encodeURIComponent(m.tenantId)}`}
                  title={`Configure ${m.tenantName}`}
                  aria-label={`Configure tenant ${m.tenantName}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-surface-muted)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  <Settings size={18} />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
