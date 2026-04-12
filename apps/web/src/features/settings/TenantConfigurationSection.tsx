import type { TenantSettings } from "@sm/contracts";
import { Building2 } from "lucide-react";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { TenantSettingsPatch } from "./mergeTenantSettings.js";

const AUTOMATION_ACTIONS = ["create_pr", "merge_pr", "dispatch_workflow", "push"] as const;

function parseCommaList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
  const [agentRuntimeBackend, setAgentRuntimeBackend] = useState<
    "" | "docker" | "kubernetes" | "shell"
  >("");
  const [reposInput, setReposInput] = useState("");
  const [branchesInput, setBranchesInput] = useState("");
  const [actionFlags, setActionFlags] = useState<Record<(typeof AUTOMATION_ACTIONS)[number], boolean>>({
    create_pr: false,
    merge_pr: false,
    dispatch_workflow: false,
    push: false
  });

  useEffect(() => {
    if (data) {
      setDocsUrl(data.docsUrl ?? "");
      setPreferredExecutor(data.preferredExecutor ?? "");
      setAgentRuntimeBackend(data.agentRuntimeBackend ?? "");
      const p = data.automationPolicy;
      setReposInput(p?.repos?.length ? p.repos.join(", ") : "");
      setBranchesInput(p?.branches?.length ? p.branches.join(", ") : "");
      const selected = new Set(p?.actions ?? []);
      setActionFlags({
        create_pr: selected.has("create_pr"),
        merge_pr: selected.has("merge_pr"),
        dispatch_workflow: selected.has("dispatch_workflow"),
        push: selected.has("push")
      });
    } else {
      setDocsUrl("");
      setPreferredExecutor("");
      setAgentRuntimeBackend("");
      setReposInput("");
      setBranchesInput("");
      setActionFlags({
        create_pr: false,
        merge_pr: false,
        dispatch_workflow: false,
        push: false
      });
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
    const repoList = parseCommaList(reposInput);
    const branchList = parseCommaList(branchesInput);
    const actionList = AUTOMATION_ACTIONS.filter((a) => actionFlags[a]);
    const policyEmpty = repoList.length === 0 && branchList.length === 0 && actionList.length === 0;

    const patch: TenantSettingsPatch = {
      docsUrl: docsUrl.trim() ? docsUrl.trim() : null,
      preferredExecutor: preferredExecutor === "" ? null : preferredExecutor,
      agentRuntimeBackend: agentRuntimeBackend === "" ? null : agentRuntimeBackend
    };

    if (policyEmpty) {
      if (data?.automationPolicy) {
        patch.automationPolicy = null;
      }
    } else {
      patch.automationPolicy = {
        repos: repoList,
        branches: branchList,
        actions: actionList
      };
    }

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
        <label style={labelColStyle}>
          <span style={{ color: "var(--color-text-secondary)" }}>Agent runtime (optional)</span>
          <select
            value={agentRuntimeBackend}
            onChange={(e) =>
              setAgentRuntimeBackend(e.target.value as "" | "docker" | "kubernetes" | "shell")
            }
            disabled={disabled}
            aria-label="Agent runtime backend"
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: "0.35rem 0.45rem",
              background: "var(--color-surface)",
              color: "var(--color-text-primary)",
              maxWidth: 420
            }}
          >
            <option value="">Default (Docker)</option>
            <option value="docker">Docker</option>
            <option value="kubernetes">Kubernetes</option>
            <option value="shell">Shell only</option>
          </select>
          <p style={{ ...mutedText, margin: "0.35rem 0 0", fontSize: "0.78rem" }}>
            Tells enrolled Go agents how to run workloads (Docker socket, kubectl, or shell). Applies on next WebSocket
            connection.
          </p>
        </label>

        <div style={{ marginTop: "0.5rem", marginBottom: "0.35rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
          Automation policy (optional allowlists — empty lists mean &quot;any&quot; only when combined with non-empty other fields; use the kill switch below to disable all automation)
        </div>
        <label style={labelColStyle}>
          <span style={{ color: "var(--color-text-secondary)" }}>Allowed repos (comma or space separated)</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
            <input
              value={reposInput}
              onChange={(e) => setReposInput(e.target.value)}
              disabled={disabled}
              placeholder="org/repo-a, org/repo-b"
              style={{ ...inputStyle, flex: "1 1 200px", maxWidth: "100%", minWidth: 0 }}
              aria-label="Automation allowed repositories"
            />
          </div>
        </label>
        <label style={labelColStyle}>
          <span style={{ color: "var(--color-text-secondary)" }}>Allowed branches (comma or space separated)</span>
          <input
            value={branchesInput}
            onChange={(e) => setBranchesInput(e.target.value)}
            disabled={disabled}
            placeholder="main, develop"
            style={{ ...inputStyle, maxWidth: "100%" }}
            aria-label="Automation allowed branches"
          />
        </label>
        <fieldset disabled={disabled} style={{ border: "none", padding: 0, margin: "0 0 0.65rem" }}>
          <legend style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginBottom: "0.35rem" }}>
            Allowed actions
          </legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.65rem" }}>
            {AUTOMATION_ACTIONS.map((a) => (
              <label key={a} style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem", cursor: disabled ? "not-allowed" : "pointer" }}>
                <input
                  type="checkbox"
                  checked={actionFlags[a]}
                  onChange={(e) => setActionFlags((prev) => ({ ...prev, [a]: e.target.checked }))}
                  aria-label={`Allow action ${a}`}
                />
                <code style={{ fontSize: "0.8rem" }}>{a}</code>
              </label>
            ))}
          </div>
        </fieldset>

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
