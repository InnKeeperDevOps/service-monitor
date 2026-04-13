import type { TenantSettings } from "@sm/contracts";
import { Building2 } from "lucide-react";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { TenantSettingsPatch } from "./mergeTenantSettings.js";

const sectionStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  padding: "1rem",
  marginBottom: "1rem"
};

const h3Style: CSSProperties = { margin: "0 0 0.75rem", fontSize: "1rem", display: "flex", alignItems: "center", gap: "0.4rem" };
const mutedText: CSSProperties = { color: "var(--color-text-secondary)", margin: 0, fontSize: "0.85rem" };
const inputStyle: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "0.35rem 0.45rem",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)",
  width: "100%",
  maxWidth: 420,
  boxSizing: "border-box" as const
};
const labelColStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.8rem", marginBottom: "0.65rem" };

type Props = {
  tenantId: string;
  canEdit: boolean;
  data: TenantSettings | null;
  loading: boolean;
  error: string | null;
  isSaving: boolean;
  savePatch: (patch: TenantSettingsPatch) => Promise<void>;
  onClearError: () => void;
};

export function TenantConfigurationSection({
  tenantId,
  canEdit,
  data,
  loading,
  error,
  isSaving,
  savePatch,
  onClearError
}: Props) {
  const [docsUrl, setDocsUrl] = useState("");
  const [preferredExecutor, setPreferredExecutor] = useState<"" | "cursor" | "claude">("");

  useEffect(() => {
    if (data) {
      setDocsUrl(data.docsUrl ?? "");
      setPreferredExecutor(data.preferredExecutor ?? "");
    } else {
      setDocsUrl("");
      setPreferredExecutor("");
    }
  }, [data]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onClearError();
    try {
      await submitTenantPatch();
    } catch {
      /* validation/API errors are shown via hook `error` */
    }
  }

  async function submitTenantPatch() {
    const patch: TenantSettingsPatch = {
      docsUrl: docsUrl.trim() ? docsUrl.trim() : null,
      preferredExecutor: preferredExecutor === "" ? null : preferredExecutor
    };

    await savePatch(patch);
  }

  const disabled = !canEdit || loading || isSaving;

  return (
    <div style={sectionStyle}>
      <h3 style={h3Style}>
        <Building2 size={16} /> Tenant Configuration
      </h3>
      {loading && <p style={mutedText}>Loading tenant settings…</p>}
      {error && (
        <p style={{ color: "var(--color-danger)", fontSize: "0.85rem", margin: "0 0 0.75rem" }}>{error}</p>
      )}
      {!canEdit && (
        <p style={{ ...mutedText, marginBottom: "0.75rem" }}>
          Only owners, admins, and operators can change tenant settings. Viewers see the current configuration only.
        </p>
      )}
      <form onSubmit={(e) => void handleSubmit(e)}>
        <label style={labelColStyle}>
          <span style={{ color: "var(--color-text-secondary)" }}>Tenant ID</span>
          <input value={tenantId} readOnly style={{ ...inputStyle, opacity: 0.85 }} aria-label="Tenant ID" />
        </label>
        <label style={labelColStyle}>
          <span style={{ color: "var(--color-text-secondary)" }}>Documentation URL (optional)</span>
          <input
            value={docsUrl}
            onChange={(e) => setDocsUrl(e.target.value)}
            disabled={disabled}
            placeholder="https://docs.example.com"
            style={{ ...inputStyle, maxWidth: "100%" }}
            aria-label="Documentation URL"
            type="url"
          />
        </label>
        <label style={labelColStyle}>
          <span style={{ color: "var(--color-text-secondary)" }}>Preferred executor (optional)</span>
          <select
            value={preferredExecutor}
            onChange={(e) => setPreferredExecutor(e.target.value as "" | "cursor" | "claude")}
            disabled={disabled}
            aria-label="Preferred executor"
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: "0.35rem 0.45rem",
              background: "var(--color-surface)",
              color: "var(--color-text-primary)",
              maxWidth: 420
            }}
          >
            <option value="">No preference</option>
            <option value="cursor">Cursor</option>
            <option value="claude">Claude</option>
          </select>
        </label>

        <div style={{ marginTop: "0.5rem", marginBottom: "0.35rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
          {/* Automation policy removed */}
        </div>

        <button
          type="submit"
          disabled={disabled}
          style={{
            background: "var(--color-primary)",
            color: "var(--color-primary-foreground)",
            border: "none",
            borderRadius: 6,
            padding: "0.45rem 0.8rem",
            fontSize: "0.85rem",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.75 : 1,
            marginTop: "0.25rem"
          }}
        >
          {isSaving ? "Saving…" : "Save tenant settings"}
        </button>
      </form>
    </div>
  );
}
