import { useEffect, useState } from "react";
import { Settings, Key, GitBranch, Lock } from "lucide-react";
import { api, type AuthProviderEntry, type OAuthProviderConfigPayload } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

const GOOGLE_OAUTH_DEFAULTS: Pick<OAuthProviderConfigPayload, "id" | "provider" | "authorizeUrl" | "tokenUrl" | "userInfoUrl" | "scopes"> = {
  id: "google",
  provider: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  scopes: ["openid", "email", "profile"]
};

function parseScopesInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type TokenInfo = {
  id: string;
  tenantId: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
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
const inputStyle: React.CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "0.35rem 0.45rem",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)",
  width: "100%",
  maxWidth: 420,
  boxSizing: "border-box" as const
};
const labelColStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.8rem", marginBottom: "0.65rem" };

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
  const { user } = useAuth();
  const canManageOAuth = user?.role === "owner" || user?.role === "admin";
  const canManageGithub = user?.role === "owner" || user?.role === "admin";

  const [authProviders, setAuthProviders] = useState<AuthProviderEntry[]>([]);
  const [oauthId, setOauthId] = useState("");
  const [oauthProviderKind, setOauthProviderKind] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthAuthorizeUrl, setOauthAuthorizeUrl] = useState("");
  const [oauthTokenUrl, setOauthTokenUrl] = useState("");
  const [oauthUserInfoUrl, setOauthUserInfoUrl] = useState("");
  const [oauthScopesInput, setOauthScopesInput] = useState("");
  const [oauthFormError, setOauthFormError] = useState<string | null>(null);
  const [oauthSuccess, setOauthSuccess] = useState<string | null>(null);
  const [isSubmittingOAuth, setIsSubmittingOAuth] = useState(false);

  const [githubAppId, setGithubAppId] = useState("");
  const [githubInstallUrl, setGithubInstallUrl] = useState<string | null>(null);
  const [githubPrivateKeyPem, setGithubPrivateKeyPem] = useState("");
  const [githubWebhookSecret, setGithubWebhookSecret] = useState("");
  const [githubPrivateKeyConfigured, setGithubPrivateKeyConfigured] = useState(false);
  const [githubWebhookSecretConfigured, setGithubWebhookSecretConfigured] = useState(false);
  const [githubFormError, setGithubFormError] = useState<string | null>(null);
  const [githubSuccess, setGithubSuccess] = useState<string | null>(null);
  const [isSavingGithub, setIsSavingGithub] = useState(false);
  const [syncInstallationIdInput, setSyncInstallationIdInput] = useState("");
  const [isSyncingInstallation, setIsSyncingInstallation] = useState(false);
  const [syncInstallationError, setSyncInstallationError] = useState<string | null>(null);

  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [installations, setInstallations] = useState<GithubInstallation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<EnrollmentTokenPreset>("24h");
  const [expiresAtInput, setExpiresAtInput] = useState<string>(() => toPresetExpiration("24h"));
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const [deactivatingTokenId, setDeactivatingTokenId] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [latestToken, setLatestToken] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [commandCopyMessage, setCommandCopyMessage] = useState<string | null>(null);

  useEffect(() => {
    api.listEnrollmentTokens().then((r) => setTokens(r.tokens)).catch(() => {});
    api.listGithubInstallations().then((r) => setInstallations(r.installations)).catch(() => {});
    api.getAuthProviders().then((r) => setAuthProviders(r.providers)).catch(() => {});

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

  useEffect(() => {
    api
      .getGithubAppSettings()
      .then((s) => {
        setGithubInstallUrl(s.installUrl ?? null);
        if (canManageGithub) {
          setGithubAppId(s.appId ?? "");
          setGithubPrivateKeyConfigured(s.privateKeyConfigured);
          setGithubWebhookSecretConfigured(s.webhookSecretConfigured);
        }
      })
      .catch(() => {});
  }, [canManageGithub]);

  async function handleSaveGithubApp() {
    setGithubFormError(null);
    setGithubSuccess(null);
    const id = githubAppId.trim();
    if (!id) {
      setGithubFormError("App ID is required.");
      return;
    }
    setIsSavingGithub(true);
    try {
      await api.updateGithubAppSettings({
        githubAppId: id,
        githubAppPrivateKeyPem: githubPrivateKeyPem,
        githubWebhookSecret: githubWebhookSecret
      });
      setGithubPrivateKeyPem("");
      setGithubWebhookSecret("");
      setGithubSuccess("GitHub App settings saved. Restart workers if GitHub automation does not pick up changes immediately.");
      const s = await api.getGithubAppSettings();
      setGithubInstallUrl(s.installUrl ?? null);
      setGithubPrivateKeyConfigured(s.privateKeyConfigured);
      setGithubWebhookSecretConfigured(s.webhookSecretConfigured);
      setError(null);
    } catch (e) {
      setGithubFormError((e as Error).message);
    } finally {
      setIsSavingGithub(false);
    }
  }

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

  function enrollmentTokenStatus(t: TokenInfo): string {
    if (t.isActive) {
      return "Active";
    }
    if (t.revokedAt && !t.usedAt) {
      return "Revoked";
    }
    if (t.usedAt) {
      return "Used";
    }
    return "Expired";
  }

  async function handleDeactivateEnrollmentToken(tokenId: string) {
    const token = tokens.find((entry) => entry.id === tokenId);
    if (!token || !token.isActive) {
      return;
    }
    const confirmed = window.confirm(
      "Deactivate this enrollment token? It will no longer work for new agent connections."
    );
    if (!confirmed) {
      return;
    }
    setTokenError(null);
    setDeactivatingTokenId(tokenId);
    try {
      await api.deactivateEnrollmentToken(tokenId);
      setTokens((prev) =>
        prev.map((entry) =>
          entry.id === tokenId
            ? {
                ...entry,
                isActive: false,
                revokedAt: new Date().toISOString()
              }
            : entry
        )
      );
      setError(null);
    } catch (e) {
      setTokenError((e as Error).message);
    } finally {
      setDeactivatingTokenId(null);
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

  async function refreshAuthProviders() {
    try {
      const r = await api.getAuthProviders();
      setAuthProviders(r.providers);
    } catch {
      /* ignore */
    }
  }

  async function handleSubmitOAuthProvider() {
    setOauthFormError(null);
    setOauthSuccess(null);

    const scopes = parseScopesInput(oauthScopesInput);
    const payload: OAuthProviderConfigPayload = {
      id: oauthId.trim(),
      provider: oauthProviderKind.trim(),
      clientId: oauthClientId.trim(),
      clientSecret: oauthClientSecret,
      authorizeUrl: oauthAuthorizeUrl.trim(),
      tokenUrl: oauthTokenUrl.trim(),
      userInfoUrl: oauthUserInfoUrl.trim(),
      scopes
    };

    if (!payload.id || !payload.provider || !payload.clientId) {
      setOauthFormError("Provider id, provider type, and client id are required.");
      return;
    }
    if (!payload.authorizeUrl || !payload.tokenUrl || !payload.userInfoUrl) {
      setOauthFormError("Authorize, token, and user info URLs are required.");
      return;
    }

    setIsSubmittingOAuth(true);
    try {
      await api.createOAuthProvider(payload);
      setOauthClientSecret("");
      setOauthSuccess(`Provider “${payload.id}” saved. It appears on the login page for OAuth sign-in.`);
      await refreshAuthProviders();
      setError(null);
    } catch (e) {
      setOauthFormError((e as Error).message);
    } finally {
      setIsSubmittingOAuth(false);
    }
  }

  function applyGoogleDefaults() {
    setOauthFormError(null);
    setOauthSuccess(null);
    setOauthId(GOOGLE_OAUTH_DEFAULTS.id);
    setOauthProviderKind(GOOGLE_OAUTH_DEFAULTS.provider);
    setOauthAuthorizeUrl(GOOGLE_OAUTH_DEFAULTS.authorizeUrl);
    setOauthTokenUrl(GOOGLE_OAUTH_DEFAULTS.tokenUrl);
    setOauthUserInfoUrl(GOOGLE_OAUTH_DEFAULTS.userInfoUrl);
    setOauthScopesInput(GOOGLE_OAUTH_DEFAULTS.scopes.join(" "));
  }

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Settings size={20} /> Settings
      </h2>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: "0.5rem" }}>{error}</div>}
      {syncMessage && <div style={{ color: "var(--color-success)", marginBottom: "0.5rem" }}>{syncMessage}</div>}

      {/* Authentication */}
      <div style={sectionStyle}>
        <h3 style={h3Style}>
          <Lock size={16} /> Authentication
        </h3>
        <p style={mutedText}>
          Email and password sign-in uses local accounts on the login page. Configure OAuth/OIDC providers here (or via{" "}
          <code>POST /api/v1/settings/oauth-providers</code>) so users see &quot;Sign in with …&quot; on the login page.
        </p>
        {authProviders.length === 0 ? (
          <p style={{ ...mutedText, marginTop: "0.5rem" }}>No OAuth providers configured yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
            <thead>
              <tr>
                {["ID", "Name", "Provider"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "0.4rem",
                      borderBottom: "1px solid var(--color-border)",
                      color: "var(--color-text-secondary)",
                      fontSize: "0.8rem"
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {authProviders.map((p) => (
                <tr key={p.id}>
                  <td style={{ padding: "0.4rem", fontSize: "0.85rem", fontFamily: "monospace" }}>{p.id}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.85rem" }}>{p.name}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.85rem" }}>{p.provider}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!canManageOAuth && (
          <p style={{ ...mutedText, marginTop: "0.75rem" }}>
            Only owners and admins can add or change OAuth providers. Ask an administrator to update configuration.
          </p>
        )}
        {canManageOAuth && (
          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Add OAuth provider</span>
              <button
                type="button"
                onClick={applyGoogleDefaults}
                style={{
                  background: "var(--color-surface-muted)",
                  color: "var(--color-text-primary)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  padding: "0.3rem 0.55rem",
                  fontSize: "0.78rem",
                  cursor: "pointer"
                }}
              >
                Use Google defaults
              </button>
            </div>
            {oauthFormError && (
              <p style={{ color: "var(--color-danger)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>{oauthFormError}</p>
            )}
            {oauthSuccess && (
              <p style={{ color: "var(--color-success)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>{oauthSuccess}</p>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0 1rem" }}>
              <label style={labelColStyle}>
                <span style={{ color: "var(--color-text-secondary)" }}>Provider id</span>
                <input
                  aria-label="Provider id"
                  value={oauthId}
                  onChange={(e) => setOauthId(e.target.value)}
                  placeholder="e.g. google"
                  autoComplete="off"
                  style={inputStyle}
                />
              </label>
              <label style={labelColStyle}>
                <span style={{ color: "var(--color-text-secondary)" }}>Provider type</span>
                <input
                  aria-label="Provider type"
                  value={oauthProviderKind}
                  onChange={(e) => setOauthProviderKind(e.target.value)}
                  placeholder="google, oidc, …"
                  autoComplete="off"
                  style={inputStyle}
                />
              </label>
            </div>
            <label style={labelColStyle}>
              <span style={{ color: "var(--color-text-secondary)" }}>Client ID</span>
              <input
                aria-label="Client ID"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                autoComplete="off"
                style={inputStyle}
              />
            </label>
            <label style={labelColStyle}>
              <span style={{ color: "var(--color-text-secondary)" }}>Client secret</span>
              <input
                aria-label="Client secret"
                type="password"
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                autoComplete="new-password"
                style={inputStyle}
              />
            </label>
            <label style={labelColStyle}>
              <span style={{ color: "var(--color-text-secondary)" }}>Authorize URL</span>
              <input
                aria-label="Authorize URL"
                value={oauthAuthorizeUrl}
                onChange={(e) => setOauthAuthorizeUrl(e.target.value)}
                style={{ ...inputStyle, maxWidth: "100%" }}
              />
            </label>
            <label style={labelColStyle}>
              <span style={{ color: "var(--color-text-secondary)" }}>Token URL</span>
              <input
                aria-label="Token URL"
                value={oauthTokenUrl}
                onChange={(e) => setOauthTokenUrl(e.target.value)}
                style={{ ...inputStyle, maxWidth: "100%" }}
              />
            </label>
            <label style={labelColStyle}>
              <span style={{ color: "var(--color-text-secondary)" }}>User info URL</span>
              <input
                aria-label="User info URL"
                value={oauthUserInfoUrl}
                onChange={(e) => setOauthUserInfoUrl(e.target.value)}
                style={{ ...inputStyle, maxWidth: "100%" }}
              />
            </label>
            <label style={labelColStyle}>
              <span style={{ color: "var(--color-text-secondary)" }}>Scopes (space or comma separated)</span>
              <textarea
                aria-label="OAuth scopes"
                value={oauthScopesInput}
                onChange={(e) => setOauthScopesInput(e.target.value)}
                rows={2}
                placeholder="openid email profile"
                style={{
                  ...inputStyle,
                  maxWidth: "100%",
                  resize: "vertical" as const,
                  minHeight: "2.5rem",
                  fontFamily: "inherit"
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => void handleSubmitOAuthProvider()}
              disabled={isSubmittingOAuth}
              style={{
                background: "var(--color-primary)",
                color: "var(--color-primary-foreground)",
                border: "none",
                borderRadius: 6,
                padding: "0.45rem 0.8rem",
                fontSize: "0.85rem",
                cursor: isSubmittingOAuth ? "not-allowed" : "pointer",
                opacity: isSubmittingOAuth ? 0.75 : 1,
                marginTop: "0.25rem"
              }}
            >
              {isSubmittingOAuth ? "Saving…" : "Save provider"}
            </button>
          </div>
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
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{enrollmentTokenStatus(t)}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{new Date(t.expiresAt).toLocaleString()}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{t.createdBy}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>{t.usedAt ? "Yes" : "No"}</td>
                  <td style={{ padding: "0.4rem", fontSize: "0.8rem" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                      <button
                        type="button"
                        aria-label={`Deactivate token ${t.id}`}
                        onClick={() => void handleDeactivateEnrollmentToken(t.id)}
                        disabled={deactivatingTokenId === t.id || !t.isActive}
                        style={{
                          background: "var(--color-surface-muted)",
                          color: "var(--color-text-primary)",
                          border: "1px solid var(--color-border)",
                          borderRadius: 6,
                          padding: "0.3rem 0.55rem",
                          fontSize: "0.75rem",
                          cursor: deactivatingTokenId === t.id || !t.isActive ? "not-allowed" : "pointer",
                          opacity: deactivatingTokenId === t.id || !t.isActive ? 0.7 : 1
                        }}
                      >
                        {deactivatingTokenId === t.id ? "Deactivating..." : "Deactivate"}
                      </button>
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>


      {/* GitHub App */}
      <div style={sectionStyle}>
        <h3 style={h3Style}><GitBranch size={16} /> GitHub App</h3>
        <p style={mutedText}>
          Configure the GitHub App <strong>webhook URL</strong> to{" "}
          <code>
            {typeof window !== "undefined" ? `${window.location.origin}/webhooks/github` : "/webhooks/github"}
          </code>{" "}
          and <strong>Setup URL</strong> to{" "}
          <code>{typeof window !== "undefined" ? `${window.location.origin}/` : "https://your-host/"}</code>
          . After you install the app on GitHub, you are redirected back here with <code>installation_id</code> and sync runs automatically.
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
                textDecoration: "none"
              }}
            >
              Install on GitHub
            </a>
            <p style={{ ...mutedText, marginTop: "0.5rem", marginBottom: 0, fontSize: "0.8rem" }}>
              Opens GitHub to authorize this app for your org or account. No extra fields to fill in here.
            </p>
          </div>
        ) : (
          <p style={{ ...mutedText, marginTop: "0.75rem", marginBottom: 0, fontSize: "0.85rem" }}>
            The install link appears once the server has GitHub App credentials (or <code>GITHUB_APP_SLUG</code>). Ask an administrator to complete the one-time setup
            {canManageGithub ? " under Advanced below" : ""}, or use manual sync if you already know the installation ID.
          </p>
        )}
        {!canManageGithub && (
          <p style={{ ...mutedText, marginTop: "0.75rem" }}>
            Only owners and admins can change server credentials. Installations for this tenant are listed below.
          </p>
        )}
        {canManageGithub && (
          <details style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--color-border)" }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: "0.9rem",
                color: "var(--color-text-secondary)",
                fontWeight: 600
              }}
            >
              Advanced: GitHub App credentials (server / kaiad.config.json)
            </summary>
            <div style={{ marginTop: "0.75rem" }}>
              {githubFormError && (
                <p style={{ color: "var(--color-danger)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>{githubFormError}</p>
              )}
              {githubSuccess && (
                <p style={{ color: "var(--color-success)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>{githubSuccess}</p>
              )}
              <p style={{ ...mutedText, marginBottom: "0.65rem", fontSize: "0.8rem" }}>
                App ID and private key are usually set once at install time. The server also discovers the public app slug from GitHub when these are valid.
              </p>
              <label style={labelColStyle}>
                <span style={{ color: "var(--color-text-secondary)" }}>App ID</span>
                <input
                  aria-label="GitHub App ID"
                  value={githubAppId}
                  onChange={(e) => setGithubAppId(e.target.value)}
                  placeholder="123456"
                  autoComplete="off"
                  style={inputStyle}
                />
              </label>
              <div className="sm-input-wrapper" style={{ marginBottom: "0.65rem" }}>
                <label className="sm-input-label" htmlFor="settings-github-pem" style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                  Private Key (PEM)
                </label>
                <textarea
                  id="settings-github-pem"
                  aria-label="GitHub App private key PEM"
                  className="sm-input"
                  rows={5}
                  value={githubPrivateKeyPem}
                  onChange={(e) => setGithubPrivateKeyPem(e.target.value)}
                  placeholder={githubPrivateKeyConfigured ? "Leave blank to keep existing key" : "-----BEGIN RSA PRIVATE KEY-----"}
                  style={{ resize: "vertical", fontFamily: "monospace", fontSize: "0.8rem", width: "100%", maxWidth: 420, boxSizing: "border-box" }}
                />
              </div>
              <label style={labelColStyle}>
                <span style={{ color: "var(--color-text-secondary)" }}>Webhook secret</span>
                <input
                  aria-label="GitHub webhook secret"
                  type="password"
                  value={githubWebhookSecret}
                  onChange={(e) => setGithubWebhookSecret(e.target.value)}
                  placeholder={githubWebhookSecretConfigured ? "Leave blank to keep existing secret" : "whsec_…"}
                  autoComplete="new-password"
                  style={inputStyle}
                />
              </label>
              <button
                type="button"
                onClick={() => void handleSaveGithubApp()}
                disabled={isSavingGithub}
                style={{
                  background: "var(--color-primary)",
                  color: "var(--color-primary-foreground)",
                  border: "none",
                  borderRadius: 6,
                  padding: "0.45rem 0.8rem",
                  fontSize: "0.85rem",
                  cursor: isSavingGithub ? "not-allowed" : "pointer",
                  opacity: isSavingGithub ? 0.75 : 1,
                  marginTop: "0.25rem"
                }}
              >
                {isSavingGithub ? "Saving…" : "Save GitHub App"}
              </button>
            </div>
          </details>
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
                marginBottom: "0.65rem"
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
    </section>
  );
}
