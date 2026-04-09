import { type CSSProperties } from "react";
import { Building2 } from "lucide-react";
import type { AuthUser } from "../lib/useAuth.js";
import { useSwitchActiveTenant } from "../hooks/useSwitchActiveTenant.js";

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.7rem",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--color-nav-muted)",
  marginBottom: "0.35rem",
  paddingLeft: "0.05rem"
};

const selectStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.5rem",
  fontSize: "0.85rem",
  color: "var(--color-nav-text)",
  background: "var(--color-nav-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  cursor: "pointer",
  outline: "none"
};

type TenantSwitcherProps = {
  user: AuthUser | null;
  onUserUpdated: (u: AuthUser) => void;
  /**
   * When false, `/api/v1/me` has not finished — show a placeholder so the sidebar is not empty above Logout.
   * Standalone tests omit this (defaults to true).
   */
  meResolved?: boolean;
};

export function TenantSwitcher({ user, onUserUpdated, meResolved = true }: TenantSwitcherProps) {
  const { switchTenant, busy, error } = useSwitchActiveTenant(onUserUpdated);

  if (!meResolved) {
    return (
      <div style={{ padding: "0 1rem 0.75rem" }}>
        <div style={labelStyle} aria-hidden>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <Building2 size={12} aria-hidden />
            Workspace
          </span>
        </div>
        <div
          data-testid="nav-workspace-loading"
          style={{
            ...selectStyle,
            opacity: 0.65,
            cursor: "wait",
            display: "flex",
            alignItems: "center"
          }}
          aria-busy="true"
        >
          Loading…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: "0 1rem 0.75rem", fontSize: "0.75rem", color: "var(--color-danger)" }} role="status">
        Workspace unavailable — try refreshing the page.
      </div>
    );
  }

  const rawMemberships =
    user.memberships.length > 0
      ? user.memberships
      : [{ tenantId: user.tenantId, tenantName: user.tenantId, role: user.role }];

  const memberships = [...rawMemberships].sort((a, b) =>
    a.tenantName.localeCompare(b.tenantName, undefined, { sensitivity: "base" })
  );

  return (
    <div style={{ padding: "0 1rem 0.75rem" }}>
      <div style={labelStyle} aria-hidden>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <Building2 size={12} aria-hidden />
          Workspace
        </span>
      </div>
      <select
        data-testid="nav-workspace-select"
        aria-label="Select workspace"
        disabled={busy}
        value={user.tenantId}
        onChange={(ev) => {
          const next = ev.target.value;
          if (next && next !== user.tenantId) {
            void switchTenant(next).catch(() => {
              /* error is shown via hook state; avoid unhandled rejection */
            });
          }
        }}
        style={{
          ...selectStyle,
          opacity: busy ? 0.7 : 1,
          cursor: busy ? "wait" : "pointer"
        }}
      >
        {memberships.map((m) => (
          <option key={m.tenantId} value={m.tenantId}>
            {m.tenantName}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" style={{ margin: "0.35rem 0 0", fontSize: "0.75rem", color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
