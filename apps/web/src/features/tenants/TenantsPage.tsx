import { useState } from "react";
import { Building2, Settings, Trash2 } from "lucide-react";
import { api, meResponseToAuthUser } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import type { AuthUser } from "../../lib/useAuth.js";
import { Button } from "../../components/Button.js";

const muted: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: "0.85rem" };
const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto auto",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.65rem 0",
  borderBottom: "1px solid var(--color-border)",
  fontSize: "0.9rem",
};

function canDeleteTenant(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function TenantsPage({ onAuthUserUpdated }: { onAuthUserUpdated: (u: AuthUser) => void }) {
  const { user } = useAuth();
  const memberships = user?.memberships ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTenantId, setNewTenantId] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreateErr("Name is required.");
      return;
    }
    setCreateErr(null);
    setCreateBusy(true);
    try {
      const rawId = newTenantId.trim();
      const me = await api.createTenant({
        name,
        ...(rawId ? { tenantId: rawId } : {})
      });
      onAuthUserUpdated(meResponseToAuthUser(me));
      setNewName("");
      setNewTenantId("");
      setShowCreate(false);
    } catch (e) {
      setCreateErr((e as Error).message ?? "Failed to create tenant");
    } finally {
      setCreateBusy(false);
    }
  };

  const confirmDelete = async (tenantId: string, tenantName: string) => {
    if (
      !window.confirm(
        `Delete workspace “${tenantName}” (${tenantId})? This removes all data for that tenant and cannot be undone.`
      )
    ) {
      return;
    }
    setDeleteErr(null);
    setDeleteBusyId(tenantId);
    try {
      await api.deleteTenant(tenantId);
      try {
        const me = await api.me();
        onAuthUserUpdated(meResponseToAuthUser(me));
      } catch {
        api.logout();
      }
    } catch (e) {
      setDeleteErr((e as Error).message ?? "Failed to delete tenant");
    } finally {
      setDeleteBusyId(null);
    }
  };

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Building2 size={20} /> Tenants
      </h2>
      <p style={{ ...muted, marginBottom: "1rem" }}>
        Workspaces you belong to. Open configuration for repo defaults, automation policy, and executors.
      </p>

      <div style={{ marginBottom: "1.25rem", display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        {!showCreate ? (
          <Button type="button" variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            New tenant
          </Button>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              padding: "0.75rem",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              background: "var(--color-surface-muted)",
              minWidth: "min(100%, 320px)",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
              <span style={{ color: "var(--color-text-secondary)" }}>Display name</span>
              <input
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                placeholder="e.g. Acme Platform"
                style={{
                  padding: "0.4rem 0.5rem",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                  color: "var(--color-text-primary)",
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
              <span style={{ color: "var(--color-text-secondary)" }}>Tenant id (optional)</span>
              <input
                value={newTenantId}
                onChange={(ev) => setNewTenantId(ev.target.value)}
                placeholder="t-my-org"
                style={{
                  fontFamily: "monospace",
                  fontSize: "0.85rem",
                  padding: "0.4rem 0.5rem",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                  color: "var(--color-text-primary)",
                }}
              />
            </label>
            {createErr && <p style={{ ...muted, color: "var(--color-danger, #c62828)", margin: 0 }}>{createErr}</p>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button type="button" variant="primary" size="sm" loading={createBusy} onClick={() => void submitCreate()}>
                Create
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={createBusy}
                onClick={() => {
                  setShowCreate(false);
                  setCreateErr(null);
                  setNewName("");
                  setNewTenantId("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {deleteErr && (
        <p style={{ ...muted, color: "var(--color-danger, #c62828)", marginBottom: "1rem" }}>{deleteErr}</p>
      )}

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
            <span style={{ textAlign: "right" }}>Delete</span>
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
              <div style={{ textAlign: "right" }}>
                {canDeleteTenant(m.role) ? (
                  <button
                    type="button"
                    title={`Delete ${m.tenantName}`}
                    aria-label={`Delete tenant ${m.tenantName}`}
                    disabled={deleteBusyId !== null}
                    onClick={() => void confirmDelete(m.tenantId, m.tenantName)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      border: "1px solid var(--color-border)",
                      background: "var(--color-surface-muted)",
                      color: "var(--color-danger, #c62828)",
                      cursor: deleteBusyId !== null ? "wait" : "pointer",
                      opacity: deleteBusyId === m.tenantId ? 0.6 : 1,
                    }}
                  >
                    <Trash2 size={18} />
                  </button>
                ) : (
                  <span style={{ ...muted, fontSize: "0.75rem" }}>—</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
