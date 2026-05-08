import { useEffect, useState } from "react";
import { Settings, GitBranch, Lock } from "lucide-react";
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

export function SettingsPage() {
  const { user } = useAuth();
  const canManageOAuth = user?.role === "owner" || user?.role === "admin";

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

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAuthProviders().then((r) => setAuthProviders(r.providers)).catch(() => {});
  }, []);

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
    </section>
  );
}
