import { useEffect, useState } from "react";
import { Settings, Key, Shield, GitBranch, Cpu, Lock } from "lucide-react";
import { api } from "../../lib/api.js";

type TokenInfo = { id: string; tenantId: string; expiresAt: string; createdBy: string; usedAt: string | null };
type GithubInstallation = { installationId: number; accountLogin: string; repos?: string[] };

const sectionStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  padding: "1rem",
  marginBottom: "1rem"
};

const h3Style: React.CSSProperties = { margin: "0 0 0.75rem", fontSize: "1rem", display: "flex", alignItems: "center", gap: "0.4rem" };
const mutedText: React.CSSProperties = { color: "var(--color-text-secondary)", margin: 0, fontSize: "0.85rem" };

export function SettingsPage() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [installations, setInstallations] = useState<GithubInstallation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    api.listEnrollmentTokens().then((r) => setTokens(r.tokens)).catch(() => {});
    api.getSettings().then((s) => setSettings(s)).catch(() => {});
    api.listGithubInstallations().then((r) => setInstallations(r.installations)).catch(() => {});

    const params = new URLSearchParams(window.location.search);
    const installationIdRaw = params.get("installation_id");
    const installationId = installationIdRaw ? Number(installationIdRaw) : NaN;
    if (Number.isInteger(installationId) && installationId > 0) {
      api.syncGithubInstallation(installationId)
        .then((installation) => {
          setInstallations((prev) => {
            const next = prev.filter((i) => i.installationId !== installation.installationId);
            next.push(installation);
            return next;
          });
          setSyncMessage(`Synced GitHub installation ${installation.installationId} (${installation.accountLogin}).`);
          setError(null);
        })
        .catch((e: unknown) => {
          setError((e as Error).message);
          setSyncMessage(null);
        })
        .finally(() => {
          const clean = new URL(window.location.href);
          clean.searchParams.delete("installation_id");
          clean.searchParams.delete("setup_action");
          window.history.replaceState({}, "", clean.toString());
        });
    }
  }, []);

  const policy = settings?.automationPolicy as { repos?: string[]; branches?: string[]; actions?: string[] } | undefined;

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Settings size={20} /> Settings
      </h2>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: "0.5rem" }}>{error}</div>}
      {syncMessage && <div style={{ color: "var(--color-success)", marginBottom: "0.5rem" }}>{syncMessage}</div>}

      {/* Authentication */}
      <div style={sectionStyle}>
        <h3 style={h3Style}><Lock size={16} /> Authentication</h3>
        <p style={mutedText}>
          Local users + OAuth/OIDC. Configure identity providers via the API (<code>POST /api/v1/settings</code>).
        </p>
      </div>

      {/* Tenant Configuration */}
      <div style={sectionStyle}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>Tenant Configuration</h3>
        {settings ? (
          <pre style={{ margin: 0, fontSize: "0.8rem", overflow: "auto", maxHeight: 200, background: "var(--color-surface-muted)", padding: "0.5rem", borderRadius: 6 }}>
            {JSON.stringify(settings, null, 2)}
          </pre>
        ) : (
          <p style={mutedText}>No settings configured. Use the API to upsert tenant settings.</p>
        )}
      </div>

      {/* Enrollment Tokens */}
      <div style={sectionStyle}>
        <h3 style={h3Style}><Key size={16} /> Enrollment Tokens</h3>
        {tokens.length === 0 ? (
          <p style={mutedText}>No enrollment tokens created.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["ID", "Expires", "Created By", "Used"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem", fontFamily: "monospace" }}>{t.id.slice(0, 12)}...</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{new Date(t.expiresAt).toLocaleString()}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{t.createdBy}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{t.usedAt ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Automation Policy */}
      <div style={sectionStyle}>
        <h3 style={h3Style}><Shield size={16} /> Automation Policy</h3>
        {policy ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <tbody>
              <tr>
                <td style={{ padding: "0.4rem", fontWeight: 600, verticalAlign: "top", width: 120 }}>Repos</td>
                <td style={{ padding: "0.4rem" }}>{policy.repos?.length ? policy.repos.join(", ") : <span style={mutedText}>any</span>}</td>
              </tr>
              <tr>
                <td style={{ padding: "0.4rem", fontWeight: 600, verticalAlign: "top" }}>Branches</td>
                <td style={{ padding: "0.4rem" }}>{policy.branches?.length ? policy.branches.join(", ") : <span style={mutedText}>any</span>}</td>
              </tr>
              <tr>
                <td style={{ padding: "0.4rem", fontWeight: 600, verticalAlign: "top" }}>Actions</td>
                <td style={{ padding: "0.4rem" }}>{policy.actions?.length ? policy.actions.join(", ") : <span style={mutedText}>any</span>}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p style={mutedText}>No automation policy configured. Configure via <code>POST /api/v1/settings</code>.</p>
        )}
        <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid var(--color-border)" }}>
          <button
            onClick={() => {
              if (window.confirm("This will disable ALL automated GitHub operations (merge, push, PR, workflow dispatch) for this tenant. Continue?")) {
                api.updateSettings?.({ automationPolicy: { repos: [], branches: [], actions: [] } })
                  .then((updated) => {
                    setSettings(updated);
                    setError(null);
                  })
                  .catch((e: unknown) => {
                    setError((e as Error).message);
                  });
              }
            }}
            style={{
              background: "var(--color-danger)",
              color: "var(--color-primary-foreground)",
              border: "none",
              borderRadius: 6,
              padding: "0.4rem 0.75rem",
              fontSize: "0.85rem",
              cursor: "pointer"
            }}
          >
            Kill Switch — Disable All Automation
          </button>
          <p style={{ ...mutedText, marginTop: "0.35rem", fontSize: "0.8rem" }}>
            Immediately clears all allowlisted repos, branches, and actions. Re-enable by updating the policy.
          </p>
        </div>
      </div>

      {/* GitHub App */}
      <div style={sectionStyle}>
        <h3 style={h3Style}><GitBranch size={16} /> GitHub App</h3>
        {installations.length === 0 ? (
          <p style={mutedText}>No GitHub App installations yet. After installing the GitHub App, return to this page with an <code>installation_id</code> query parameter to sync metadata automatically.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Installation ID", "Account"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {installations.map((inst) => (
                <tr key={inst.installationId}>
                  <td style={{ padding: "0.4rem", fontSize: "0.85rem", fontFamily: "monospace" }}>{inst.installationId}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.85rem" }}>{inst.accountLogin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Executors */}
      <div style={sectionStyle}>
        <h3 style={h3Style}><Cpu size={16} /> Executors</h3>
        <p style={mutedText}>
          Preferred executor: <strong>Cursor</strong> (fallback: Claude). Configure via tenant settings <code>automationPolicy</code>.
        </p>
      </div>
    </section>
  );
}
