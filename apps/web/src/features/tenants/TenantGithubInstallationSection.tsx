import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { api } from "../../lib/api.js";

type GithubInstallation = { installationId: number; accountLogin: string; repos?: string[] };

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

const labelColStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.8rem",
  marginBottom: "0.65rem",
};

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "0.35rem 0.45rem",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)",
  width: "100%",
  maxWidth: 420,
  boxSizing: "border-box" as const,
};

type Props = {
  /** Session tenant matches this page — GitHub sync applies to this tenant only. */
  tenantActive: boolean;
  /** Owners/admins see credential hints pointing at Settings; others get viewer copy. */
  canManageServerCredentials: boolean;
};

export function TenantGithubInstallationSection({
  tenantActive,
  canManageServerCredentials,
}: Props) {
  const [githubInstallUrl, setGithubInstallUrl] = useState<string | null>(null);
  const [syncInstallationIdInput, setSyncInstallationIdInput] = useState("");
  const [isSyncingInstallation, setIsSyncingInstallation] = useState(false);
  const [syncInstallationError, setSyncInstallationError] = useState<string | null>(null);
  const [installations, setInstallations] = useState<GithubInstallation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantActive) return;
    api.listGithubInstallations().then((r) => setInstallations(r.installations)).catch(() => {});
  }, [tenantActive]);

  useEffect(() => {
    api
      .getGithubAppSettings()
      .then((s) => {
        setGithubInstallUrl(s.installUrl ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!tenantActive) return;
    const params = new URLSearchParams(window.location.search);
    const installationIdRaw = params.get("installation_id");
    const installationId = installationIdRaw ? Number(installationIdRaw) : NaN;
    if (!Number.isInteger(installationId) || installationId <= 0) return;

    api
      .syncGithubInstallation(installationId)
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
  }, [tenantActive]);

  async function handleSyncInstallationManual() {
    setSyncInstallationError(null);
    const raw = syncInstallationIdInput.trim();
    const installationId = raw ? Number(raw) : NaN;
    if (!Number.isInteger(installationId) || installationId <= 0) {
      setSyncInstallationError("Enter a positive integer installation ID.");
      return;
    }
    setIsSyncingInstallation(true);
    try {
      const installation = await api.syncGithubInstallation(installationId);
      setInstallations((prev) => {
        const next = prev.filter((i) => i.installationId !== installation.installationId);
        next.push(installation);
        return next;
      });
      setSyncMessage(`Synced GitHub installation ${installation.installationId} (${installation.accountLogin}).`);
      setSyncInstallationIdInput("");
      setError(null);
    } catch (e) {
      setSyncInstallationError((e as Error).message);
    } finally {
      setIsSyncingInstallation(false);
    }
  }

  if (!tenantActive) {
    return null;
  }

  return (
    <div style={sectionStyle}>
      <h3 style={h3Style}>
        <GitBranch size={16} /> GitHub App installation
      </h3>
      <p style={mutedText}>
        Installations are stored <strong>per tenant</strong>. Set the GitHub App <strong>webhook URL</strong> to{" "}
        <code>
          {typeof window !== "undefined" ? `${window.location.origin}/webhooks/github` : "/webhooks/github"}
        </code>{" "}
        and <strong>Setup URL</strong> to{" "}
        <code>{typeof window !== "undefined" ? `${window.location.origin}/` : "https://your-host/"}</code>
        . After you install the app on GitHub, you are redirected back here with <code>installation_id</code> and sync
        runs for <strong>this tenant</strong> (use the Tenants list to switch workspaces first if needed).
      </p>
      {githubInstallUrl ? (
        <div style={{ marginTop: "1rem" }}>
          <a
            href={githubInstallUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              background: "var(--color-primary)",
              color: "var(--color-primary-foreground)",
              border: "none",
              borderRadius: 6,
              padding: "0.55rem 1rem",
              fontSize: "0.9rem",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Install on GitHub
          </a>
          <p style={{ ...mutedText, marginTop: "0.5rem", marginBottom: 0, fontSize: "0.8rem" }}>
            Opens GitHub to authorize this app for your org or account.
          </p>
        </div>
      ) : (
        <p style={{ ...mutedText, marginTop: "0.75rem", marginBottom: 0, fontSize: "0.85rem" }}>
          The install link appears once the server has GitHub App credentials (or <code>GITHUB_APP_SLUG</code>).
          {canManageServerCredentials ? (
            <> Configure them under Settings → GitHub App.</>
          ) : (
            <> Ask an owner or admin to complete the one-time setup in Settings, or use manual sync if you already know the installation ID.</>
          )}
        </p>
      )}
      {syncMessage && (
        <div style={{ color: "var(--color-success)", marginTop: "0.75rem", fontSize: "0.9rem" }}>{syncMessage}</div>
      )}
      {error && (
        <div style={{ color: "var(--color-danger)", marginTop: "0.75rem", fontSize: "0.9rem" }} role="alert">
          {error}
        </div>
      )}
      <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--color-border)" }}>
        <p style={{ ...mutedText, marginBottom: "0.65rem" }}>Sync installation metadata (after installing the app on GitHub):</p>
        {syncInstallationError && (
          <p style={{ color: "var(--color-danger)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>{syncInstallationError}</p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "end" }}>
          <label style={labelColStyle}>
            <span style={{ color: "var(--color-text-secondary)" }}>Installation ID</span>
            <input
              aria-label="GitHub installation ID to sync"
              value={syncInstallationIdInput}
              onChange={(e) => setSyncInstallationIdInput(e.target.value)}
              placeholder="12345678"
              inputMode="numeric"
              style={{ ...inputStyle, maxWidth: 200 }}
            />
          </label>
          <button
            type="button"
            onClick={() => void handleSyncInstallationManual()}
            disabled={isSyncingInstallation}
            style={{
              background: "var(--color-surface-muted)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: "0.45rem 0.8rem",
              fontSize: "0.85rem",
              cursor: isSyncingInstallation ? "not-allowed" : "pointer",
              opacity: isSyncingInstallation ? 0.75 : 1,
              marginBottom: "0.65rem",
            }}
          >
            {isSyncingInstallation ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>
      {installations.length === 0 ? (
        <p style={{ ...mutedText, marginTop: "0.75rem" }}>No GitHub App installations recorded for this tenant yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
          <thead>
            <tr>
              {["Installation ID", "Account"].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    padding: "0.4rem",
                    borderBottom: "1px solid var(--color-border)",
                    color: "var(--color-text-secondary)",
                    fontSize: "0.8rem",
                  }}
                >
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
  );
}
