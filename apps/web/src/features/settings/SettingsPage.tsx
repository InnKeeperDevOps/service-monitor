import { useEffect, useState } from "react";
import { Settings, Key, Shield, GitBranch, Cpu, Lock } from "lucide-react";
import { api } from "../../lib/api.js";

type TokenInfo = {
  id: string;
  tenantId: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  usedAt: string | null;
  isActive: boolean;
};
type GithubInstallation = { installationId: number; accountLogin: string; repos?: string[] };
type EnrollmentTokenPreset = "1h" | "24h" | "7d" | "30d";

const ENROLLMENT_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const ENROLLMENT_PRESET_SECONDS: Record<EnrollmentTokenPreset, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60
};

const sectionStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  padding: "1rem",
  marginBottom: "1rem"
};

const h3Style: React.CSSProperties = { margin: "0 0 0.75rem", fontSize: "1rem", display: "flex", alignItems: "center", gap: "0.4rem" };
const mutedText: React.CSSProperties = { color: "var(--color-text-secondary)", margin: 0, fontSize: "0.85rem" };

function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function toPresetExpiration(preset: EnrollmentTokenPreset): string {
  return formatDateTimeLocal(new Date(Date.now() + ENROLLMENT_PRESET_SECONDS[preset] * 1000));
}

function buildAgentStartCommand(token: string): string {
  const realtimeUrl =
    typeof window === "undefined"
      ? "wss://your-kaiad.example.com/realtime"
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/realtime`;
  return `SM_REALTIME_URL=${realtimeUrl} NODE_ENV=production SM_ENROLLMENT_TOKEN=${token} /usr/local/bin/agent`;
}

export function SettingsPage() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [installations, setInstallations] = useState<GithubInstallation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<EnrollmentTokenPreset>("24h");
  const [expiresAtInput, setExpiresAtInput] = useState<string>(() => toPresetExpiration("24h"));
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [latestToken, setLatestToken] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [commandCopyMessage, setCommandCopyMessage] = useState<string | null>(null);

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

  async function handleGenerateEnrollmentToken() {
    setTokenError(null);
    setLatestToken(null);
    setCopyMessage(null);
    setCommandCopyMessage(null);

    const expiration = new Date(expiresAtInput);
    if (!expiresAtInput || Number.isNaN(expiration.getTime())) {
      setTokenError("Choose a valid expiration date and time.");
      return;
    }

    const ttlSeconds = Math.floor((expiration.getTime() - Date.now()) / 1000);
    if (ttlSeconds <= 0) {
      setTokenError("Expiration must be in the future.");
      return;
    }
    if (ttlSeconds > ENROLLMENT_MAX_TTL_SECONDS) {
      setTokenError("Expiration cannot be more than 365 days from now.");
      return;
    }

    setIsGeneratingToken(true);
    try {
      const created = await api.createEnrollmentToken({ ttlSeconds });
      const { token, ...metadata } = created;
      setTokens((prev) => [metadata, ...prev]);
      setLatestToken(token);
      setError(null);
    } catch (e) {
      setTokenError((e as Error).message);
    } finally {
      setIsGeneratingToken(false);
    }
  }

  async function handleCopyToken() {
    if (!latestToken) {
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(latestToken);
      setCopyMessage("Copied token to clipboard.");
    } catch {
      setCopyMessage("Unable to copy token automatically.");
    }
  }

  async function handleCopyStartCommand() {
    if (!latestToken) {
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(buildAgentStartCommand(latestToken));
      setCommandCopyMessage("Copied command to clipboard.");
    } catch {
      setCommandCopyMessage("Unable to copy command automatically.");
    }
  }

  async function handleDeleteEnrollmentToken(tokenId: string) {
    const token = tokens.find((entry) => entry.id === tokenId);
    if (!token || token.isActive) {
      return;
    }
    const confirmed = window.confirm("Delete this inactive enrollment token?");
    if (!confirmed) {
      return;
    }
    setTokenError(null);
    setDeletingTokenId(tokenId);
    try {
      await api.deleteEnrollmentToken(tokenId);
      setTokens((prev) => prev.filter((token) => token.id !== tokenId));
      setError(null);
    } catch (e) {
      setTokenError((e as Error).message);
    } finally {
      setDeletingTokenId(null);
    }
  }

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
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "end", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.8rem" }}>
            <span style={{ color: "var(--color-text-secondary)" }}>Preset</span>
            <select
              value={selectedPreset}
              onChange={(e) => {
                const preset = e.target.value as EnrollmentTokenPreset;
                setSelectedPreset(preset);
                setExpiresAtInput(toPresetExpiration(preset));
              }}
              style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.35rem 0.45rem", background: "var(--color-surface)", color: "var(--color-text-primary)" }}
            >
              <option value="1h">1 hour</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.8rem" }}>
            <span style={{ color: "var(--color-text-secondary)" }}>Expires at</span>
            <input
              type="datetime-local"
              aria-label="Expires at"
              value={expiresAtInput}
              onChange={(e) => setExpiresAtInput(e.target.value)}
              style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.35rem 0.45rem", background: "var(--color-surface)", color: "var(--color-text-primary)" }}
            />
          </label>
          <button
            onClick={() => void handleGenerateEnrollmentToken()}
            disabled={isGeneratingToken}
            style={{
              background: "var(--color-primary)",
              color: "var(--color-primary-foreground)",
              border: "none",
              borderRadius: 6,
              padding: "0.45rem 0.8rem",
              fontSize: "0.85rem",
              cursor: isGeneratingToken ? "not-allowed" : "pointer",
              opacity: isGeneratingToken ? 0.75 : 1
            }}
          >
            {isGeneratingToken ? "Generating..." : "Generate token"}
          </button>
        </div>
        {tokenError && <p style={{ color: "var(--color-danger)", fontSize: "0.85rem", margin: "0 0 0.75rem" }}>{tokenError}</p>}
        {latestToken && (
          <div style={{ marginBottom: "0.75rem", background: "var(--color-surface-muted)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.65rem" }}>
            <div style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginBottom: "0.35rem" }}>
              New enrollment token (copy now - shown only once):
            </div>
            <code style={{ display: "block", fontSize: "0.8rem", wordBreak: "break-all" }}>{latestToken}</code>
            <div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleCopyToken()}
                style={{
                  background: "var(--color-surface)",
                  color: "var(--color-text-primary)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  padding: "0.35rem 0.65rem",
                  fontSize: "0.8rem",
                  cursor: "pointer"
                }}
              >
                Copy token
              </button>
              {copyMessage && (
                <span style={{ fontSize: "0.8rem", color: copyMessage.startsWith("Copied") ? "var(--color-success)" : "var(--color-danger)" }}>
                  {copyMessage}
                </span>
              )}
            </div>
            <div style={{ marginTop: "0.65rem" }}>
              <div style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginBottom: "0.35rem" }}>
                Start command:
              </div>
              <code style={{ display: "block", fontSize: "0.8rem", wordBreak: "break-all" }}>
                {buildAgentStartCommand(latestToken)}
              </code>
              <div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void handleCopyStartCommand()}
                  style={{
                    background: "var(--color-surface)",
                    color: "var(--color-text-primary)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    padding: "0.35rem 0.65rem",
                    fontSize: "0.8rem",
                    cursor: "pointer"
                  }}
                >
                  Copy start command
                </button>
                {commandCopyMessage && (
                  <span
                    style={{
                      fontSize: "0.8rem",
                      color: commandCopyMessage.startsWith("Copied")
                        ? "var(--color-success)"
                        : "var(--color-danger)"
                    }}
                  >
                    {commandCopyMessage}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
        {tokens.length === 0 ? (
          <p style={mutedText}>No enrollment tokens found.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["ID", "Status", "Expires", "Created By", "Used", "Actions"].map((h) => (
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
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{t.isActive ? "Active" : "Inactive"}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{new Date(t.expiresAt).toLocaleString()}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{t.createdBy}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{t.usedAt ? "Yes" : "No"}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>
                    <button
                      type="button"
                      aria-label={`Delete token ${t.id}`}
                      onClick={() => void handleDeleteEnrollmentToken(t.id)}
                      disabled={deletingTokenId === t.id || t.isActive}
                      style={{
                        background: "var(--color-danger-bg)",
                        color: "var(--color-danger)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 6,
                        padding: "0.3rem 0.55rem",
                        fontSize: "0.75rem",
                        cursor: deletingTokenId === t.id || t.isActive ? "not-allowed" : "pointer",
                        opacity: deletingTokenId === t.id || t.isActive ? 0.7 : 1
                      }}
                    >
                      {deletingTokenId === t.id ? "Deleting..." : "Delete"}
                    </button>
                  </td>
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
