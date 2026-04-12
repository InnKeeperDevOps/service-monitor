import { useEffect, useState } from "react";
import { ArrowLeft, Cpu, Settings, Shield } from "lucide-react";
import { api, meResponseToAuthUser } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import type { AuthUser } from "../../lib/useAuth.js";
import { TenantConfigurationSection } from "../settings/TenantConfigurationSection.js";
import { useTenantSettings } from "../settings/useTenantSettings.js";

const sectionStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  padding: "1rem",
  marginBottom: "1rem",
};

const h3Style: React.CSSProperties = {
  margin: "0 0 0.75rem",
  fontSize: "1rem",
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
};

const mutedText: React.CSSProperties = {
  color: "var(--color-text-secondary)",
  margin: 0,
  fontSize: "0.85rem",
};

export function TenantConfigurationPage({
  tenantIdFromRoute,
  onAuthUserUpdated,
}: {
  tenantIdFromRoute: string;
  onAuthUserUpdated: (u: AuthUser) => void;
}) {
  const { user } = useAuth();
  const [switchErr, setSwitchErr] = useState<string | null>(null);

  const allowed = user?.memberships.some((m) => m.tenantId === tenantIdFromRoute) ?? false;
  const aligned = Boolean(user && user.tenantId === tenantIdFromRoute);

  useEffect(() => {
    if (!user) return;
    if (!user.memberships.some((m) => m.tenantId === tenantIdFromRoute)) {
      window.location.hash = "tenants";
      return;
    }
    if (user.tenantId === tenantIdFromRoute) {
      setSwitchErr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const me = await api.switchActiveTenant(tenantIdFromRoute);
        if (!cancelled) {
          onAuthUserUpdated(meResponseToAuthUser(me));
          setSwitchErr(null);
        }
      } catch (e) {
        if (!cancelled) setSwitchErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, tenantIdFromRoute, onAuthUserUpdated]);

  const canManageTenantSettings =
    user?.role === "owner" || user?.role === "admin" || user?.role === "operator";

  const tenantSettings = useTenantSettings(aligned ? tenantIdFromRoute : null);

  const displayName =
    user?.memberships.find((m) => m.tenantId === tenantIdFromRoute)?.tenantName ?? tenantIdFromRoute;

  if (!allowed) {
    return null;
  }

  return (
    <section>
      <div style={{ marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <a
          href="#tenants"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            color: "var(--color-text-secondary)",
            textDecoration: "none",
            fontSize: "0.9rem",
          }}
        >
          <ArrowLeft size={18} aria-hidden /> Tenants
        </a>
      </div>

      <h2 style={{ margin: "0 0 0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Settings size={20} /> {displayName}
      </h2>
      <p style={{ ...mutedText, marginBottom: "1rem" }}>
        <span style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{tenantIdFromRoute}</span>
      </p>

      {switchErr && (
        <div style={{ color: "var(--color-danger)", marginBottom: "0.75rem" }} role="alert">
          {switchErr}
        </div>
      )}

      {!aligned && !switchErr && (
        <p style={{ ...mutedText, marginBottom: "1rem" }}>Switching to this tenant…</p>
      )}

      {aligned && user?.tenantId && (
        <TenantConfigurationSection
          tenantId={user.tenantId}
          canEdit={canManageTenantSettings}
          data={tenantSettings.data}
          loading={tenantSettings.loading}
          error={tenantSettings.error}
          isSaving={tenantSettings.isSaving}
          savePatch={tenantSettings.savePatch}
          onClearError={tenantSettings.clearError}
        />
      )}

      {aligned && (
        <div style={sectionStyle}>
          <h3 style={h3Style}>
            <Cpu size={16} /> Executors
          </h3>
          <p style={mutedText}>
            Preferred executor:{" "}
            <strong>{tenantSettings.data?.preferredExecutor === "claude" ? "Claude" : "Cursor"}</strong> (fallback:{" "}
            {tenantSettings.data?.preferredExecutor === "claude" ? "Cursor" : "Claude"}). Set in the{" "}
            <strong>Tenant configuration</strong> form above.
          </p>
        </div>
      )}
    </section>
  );
}
