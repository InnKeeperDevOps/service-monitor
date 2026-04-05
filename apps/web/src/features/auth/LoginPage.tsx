import { useState, useEffect, type FormEvent } from "react";
import { api } from "../../lib/api.js";
import { Button } from "../../components/Button.js";
import { Input } from "../../components/Input.js";

type OAuthProvider = { id: string; name: string; type: string };

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state) {
      setLoading(true);
      api
        .handleOAuthCallback(code, state)
        .then(({ token }) => {
          localStorage.setItem("sm_token", token);
          window.history.replaceState({}, "", window.location.pathname);
          window.location.hash = "dashboard";
          window.location.reload();
        })
        .catch((err) => {
          setError((err as Error).message);
          setLoading(false);
        });
    }
  }, []);

  useEffect(() => {
    api
      .getAuthProviders()
      .then((res) => setProviders(res.providers))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token } = await api.login(email, password);
      localStorage.setItem("sm_token", token);
      window.location.hash = "dashboard";
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuthLogin(provider: OAuthProvider) {
    setOauthLoading(provider.id);
    setError(null);
    try {
      const { authorizeUrl } = await api.getOAuthAuthorizeUrl(provider.id);
      window.location.href = authorizeUrl;
    } catch (err) {
      setError((err as Error).message);
      setOauthLoading(null);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "var(--color-canvas)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: 360,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 12,
          padding: "2rem",
        }}
      >
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem", fontWeight: 700 }}>
          Kaiad
        </h1>
        <p style={{ margin: "0 0 1.5rem", color: "var(--color-text-secondary)", fontSize: "0.9rem" }}>
          Sign in to continue
        </p>

        {error && (
          <div
            role="alert"
            style={{
              padding: "0.5rem 0.75rem",
              marginBottom: "1rem",
              background: "var(--color-danger-bg)",
              color: "var(--color-danger)",
              border: "1px solid var(--color-danger)",
              borderRadius: 8,
              fontSize: "0.85rem",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1.25rem" }}>
          <Input
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Input
            label="Password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        <Button type="submit" loading={loading} style={{ width: "100%" }}>
          Sign in
        </Button>

        {providers.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                marginBottom: "1rem",
                color: "var(--color-text-secondary)",
                fontSize: "0.8rem",
              }}
            >
              <span style={{ flex: 1, height: 1, background: "var(--color-border)" }} />
              or
              <span style={{ flex: 1, height: 1, background: "var(--color-border)" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {providers.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  variant="secondary"
                  loading={oauthLoading === p.id}
                  onClick={() => handleOAuthLogin(p)}
                  style={{ width: "100%" }}
                >
                  Sign in with {p.name}
                </Button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
