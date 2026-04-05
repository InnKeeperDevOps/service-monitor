import { useState, useEffect } from "react";
import { api } from "../../lib/api.js";
import { Button } from "../../components/Button.js";
import { Input } from "../../components/Input.js";
import { Card } from "../../components/Card.js";

type WizardStep = "welcome" | "infra" | "admin" | "github" | "oauth" | "tenant" | "k8s" | "review";
const STEPS: WizardStep[] = ["welcome", "infra", "admin", "github", "oauth", "tenant", "k8s", "review"];
const STEP_LABELS: Record<WizardStep, string> = {
  welcome: "Welcome",
  infra: "Infrastructure",
  admin: "Admin Account",
  github: "GitHub App",
  oauth: "OAuth",
  tenant: "Webhook Tenant",
  k8s: "Kubernetes",
  review: "Review & Finish",
};

function StepIndicator({ steps, current }: { steps: WizardStep[]; current: number }) {
  return (
    <div style={{ display: "flex", gap: "0.25rem", justifyContent: "center", marginBottom: "1.5rem", flexWrap: "wrap" }}>
      {steps.map((s, i) => (
        <div key={s} style={{
          display: "flex", alignItems: "center", gap: "0.25rem",
          color: i <= current ? "var(--color-primary)" : "var(--color-text-muted)",
          fontSize: "0.75rem", fontWeight: i === current ? 600 : 400,
        }}>
          <span style={{
            width: 22, height: 22, borderRadius: "50%", display: "flex",
            alignItems: "center", justifyContent: "center", fontSize: "0.7rem",
            fontWeight: 700,
            background: i < current ? "var(--color-primary)" : i === current ? "var(--color-primary-subtle)" : "var(--color-surface-muted)",
            color: i < current ? "#fff" : i === current ? "var(--color-primary)" : "var(--color-text-muted)",
            border: i === current ? "2px solid var(--color-primary)" : "1px solid var(--color-border)",
          }}>
            {i < current ? "✓" : i + 1}
          </span>
          <span style={{ display: i === current ? "inline" : "none" }}>{STEP_LABELS[s]}</span>
          {i < steps.length - 1 && <span style={{ color: "var(--color-border-strong)", margin: "0 0.15rem" }}>—</span>}
        </div>
      ))}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.1rem", fontWeight: 700 }}>{children}</h2>;
}

function SectionSub({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: "0 0 1.25rem", color: "var(--color-text-secondary)", fontSize: "0.85rem" }}>{children}</p>;
}

function TestBadge({ ok, error, testing }: { ok: boolean | null; error: string; testing: boolean }) {
  if (testing) return <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>Testing…</span>;
  if (ok === true) return <span style={{ fontSize: "0.8rem", color: "var(--color-success)" }}>✓ Connected</span>;
  if (ok === false) return <span style={{ fontSize: "0.8rem", color: "var(--color-danger)" }}>✗ {error || "Failed"}</span>;
  return null;
}

function ReviewRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", gap: "0.5rem", fontSize: "0.85rem", padding: "0.35rem 0", borderBottom: "1px solid var(--color-border)" }}>
      <span style={{ fontWeight: 500, minWidth: 150, color: "var(--color-text-secondary)" }}>{label}</span>
      <span style={{ wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

export function SetupWizardPage() {
  const [step, setStep] = useState(0);

  const [publicBaseUrl, setPublicBaseUrl] = useState(window.location.origin);
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [redisUrl, setRedisUrl] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [githubAppId, setGithubAppId] = useState("");
  const [githubPrivateKey, setGithubPrivateKey] = useState("");
  const [githubWebhookSecret, setGithubWebhookSecret] = useState("");
  const [enableOAuth, setEnableOAuth] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [k8sNamespace, setK8sNamespace] = useState("");

  const [dbTestOk, setDbTestOk] = useState<boolean | null>(null);
  const [dbTestError, setDbTestError] = useState("");
  const [dbTesting, setDbTesting] = useState(false);
  const [redisTestOk, setRedisTestOk] = useState<boolean | null>(null);
  const [redisTestError, setRedisTestError] = useState("");
  const [redisTesting, setRedisTesting] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    setDbTestOk(null);
    setDbTestError("");
  }, [databaseUrl]);

  useEffect(() => {
    setRedisTestOk(null);
    setRedisTestError("");
  }, [redisUrl]);

  async function testDb() {
    setDbTesting(true);
    setDbTestOk(null);
    setDbTestError("");
    try {
      await api.testDatabase(databaseUrl);
      setDbTestOk(true);
      try {
        const res = await api.getSetupTenants(databaseUrl);
        setTenants(res.tenants);
      } catch { /* tenants may not exist yet */ }
    } catch (err) {
      setDbTestOk(false);
      setDbTestError((err as Error).message);
    } finally {
      setDbTesting(false);
    }
  }

  async function testRedis() {
    setRedisTesting(true);
    setRedisTestOk(null);
    setRedisTestError("");
    try {
      await api.testRedis(redisUrl);
      setRedisTestOk(true);
    } catch (err) {
      setRedisTestOk(false);
      setRedisTestError((err as Error).message);
    } finally {
      setRedisTesting(false);
    }
  }

  async function handleFinish() {
    setSubmitting(true);
    setSubmitError("");
    try {
      await api.completeSetup({
        databaseUrl,
        redisUrl,
        publicBaseUrl,
        adminEmail,
        adminPassword,
        githubAppId: githubAppId || undefined,
        githubAppPrivateKeyPem: githubPrivateKey || undefined,
        githubWebhookSecret: githubWebhookSecret || undefined,
        googleClientId: enableOAuth ? googleClientId : undefined,
        googleClientSecret: enableOAuth ? googleClientSecret : undefined,
        defaultWebhookTenantId: selectedTenantId || undefined,
        kubernetesNamespace: k8sNamespace || undefined,
      });
      window.location.hash = "login";
      window.location.reload();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const currentStep = STEPS[step];

  const infraValid = dbTestOk === true && redisTestOk === true;
  const adminValid =
    adminEmail.length > 0 &&
    adminPassword.length >= 8 &&
    adminPassword === confirmPassword;

  function canAdvance(): boolean {
    switch (currentStep) {
      case "welcome": return true;
      case "infra": return infraValid;
      case "admin": return adminValid;
      default: return true;
    }
  }

  function renderStep() {
    switch (currentStep) {
      case "welcome":
        return (
          <>
            <SectionHeading>Welcome to Kaiad</SectionHeading>
            <SectionSub>Let's configure your instance. This wizard will guide you through setting up infrastructure, an admin account, and optional integrations.</SectionSub>
            <Input
              label="Public Base URL"
              value={publicBaseUrl}
              onChange={(e) => setPublicBaseUrl(e.target.value)}
              placeholder="https://kaiad.example.com"
            />
          </>
        );

      case "infra":
        return (
          <>
            <SectionHeading>Infrastructure</SectionHeading>
            <SectionSub>Configure your database and cache connections.</SectionSub>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div>
                <Input
                  label="Database URL"
                  value={databaseUrl}
                  onChange={(e) => setDatabaseUrl(e.target.value)}
                  placeholder="postgres://user:pass@host:5432/kaiad"
                />
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <Button size="sm" variant="secondary" onClick={testDb} disabled={!databaseUrl || dbTesting}>
                    Test Connection
                  </Button>
                  <TestBadge ok={dbTestOk} error={dbTestError} testing={dbTesting} />
                </div>
              </div>
              <div>
                <Input
                  label="Redis URL"
                  value={redisUrl}
                  onChange={(e) => setRedisUrl(e.target.value)}
                  placeholder="redis://host:6379"
                />
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <Button size="sm" variant="secondary" onClick={testRedis} disabled={!redisUrl || redisTesting}>
                    Test Connection
                  </Button>
                  <TestBadge ok={redisTestOk} error={redisTestError} testing={redisTesting} />
                </div>
              </div>
            </div>
          </>
        );

      case "admin":
        return (
          <>
            <SectionHeading>Admin Account</SectionHeading>
            <SectionSub>Create the first administrator account.</SectionSub>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <Input
                label="Email"
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@example.com"
              />
              <Input
                label="Password"
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="Min 8 characters"
                error={adminPassword.length > 0 && adminPassword.length < 8 ? "Password must be at least 8 characters" : undefined}
              />
              <Input
                label="Confirm Password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                error={confirmPassword.length > 0 && confirmPassword !== adminPassword ? "Passwords do not match" : undefined}
              />
            </div>
          </>
        );

      case "github":
        return (
          <>
            <SectionHeading>GitHub App</SectionHeading>
            <SectionSub>Optional. Connect a GitHub App for repository integration.</SectionSub>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <Input
                label="App ID"
                value={githubAppId}
                onChange={(e) => setGithubAppId(e.target.value)}
                placeholder="123456"
              />
              <div className="sm-input-wrapper">
                <label className="sm-input-label" htmlFor="gh-pem">Private Key (PEM)</label>
                <textarea
                  id="gh-pem"
                  className="sm-input"
                  rows={5}
                  value={githubPrivateKey}
                  onChange={(e) => setGithubPrivateKey(e.target.value)}
                  placeholder="-----BEGIN RSA PRIVATE KEY-----"
                  style={{ resize: "vertical", fontFamily: "monospace", fontSize: "0.8rem" }}
                />
              </div>
              <Input
                label="Webhook Secret"
                value={githubWebhookSecret}
                onChange={(e) => setGithubWebhookSecret(e.target.value)}
                placeholder="whsec_..."
              />
            </div>
          </>
        );

      case "oauth":
        return (
          <>
            <SectionHeading>OAuth Provider</SectionHeading>
            <SectionSub>Optional. Enable Google OAuth for user sign-in.</SectionSub>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem", fontSize: "0.9rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={enableOAuth}
                onChange={(e) => setEnableOAuth(e.target.checked)}
                style={{ accentColor: "var(--color-primary)" }}
              />
              Enable Google OAuth
            </label>
            {enableOAuth && (
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <Input
                  label="Client ID"
                  value={googleClientId}
                  onChange={(e) => setGoogleClientId(e.target.value)}
                  placeholder="xxxx.apps.googleusercontent.com"
                />
                <Input
                  label="Client Secret"
                  type="password"
                  value={googleClientSecret}
                  onChange={(e) => setGoogleClientSecret(e.target.value)}
                  placeholder="GOCSPX-..."
                />
              </div>
            )}
          </>
        );

      case "tenant":
        return (
          <>
            <SectionHeading>Webhook Tenant</SectionHeading>
            <SectionSub>Optional. Select a default tenant for incoming webhooks.</SectionSub>
            {tenants.length === 0 ? (
              <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
                No tenants found. Tenants will be created after setup is complete.
              </p>
            ) : (
              <div className="sm-input-wrapper">
                <label className="sm-input-label" htmlFor="tenant-select">Default Tenant</label>
                <select
                  id="tenant-select"
                  className="sm-input"
                  value={selectedTenantId}
                  onChange={(e) => setSelectedTenantId(e.target.value)}
                >
                  <option value="">— None —</option>
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} ({t.id})</option>
                  ))}
                </select>
              </div>
            )}
          </>
        );

      case "k8s":
        return (
          <>
            <SectionHeading>Kubernetes</SectionHeading>
            <SectionSub>Optional. Configure Kubernetes namespace for agent workloads.</SectionSub>
            <Input
              label="Namespace"
              value={k8sNamespace}
              onChange={(e) => setK8sNamespace(e.target.value)}
              placeholder="kaiad-agents"
            />
          </>
        );

      case "review":
        return (
          <>
            <SectionHeading>Review & Finish</SectionHeading>
            <SectionSub>Confirm your settings, then click Finish to complete setup.</SectionSub>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
              <ReviewRow label="Public Base URL" value={publicBaseUrl} />
              <ReviewRow label="Database URL" value={databaseUrl} />
              <ReviewRow label="Redis URL" value={redisUrl} />
              <ReviewRow label="Admin Email" value={adminEmail} />
              <ReviewRow label="Admin Password" value={adminPassword ? "••••••••" : undefined} />
              <ReviewRow label="GitHub App ID" value={githubAppId} />
              <ReviewRow label="GitHub Webhook Secret" value={githubWebhookSecret ? "••••" : undefined} />
              <ReviewRow label="GitHub Private Key" value={githubPrivateKey ? "(set)" : undefined} />
              <ReviewRow label="Google OAuth" value={enableOAuth ? "Enabled" : "Disabled"} />
              {enableOAuth && <ReviewRow label="Google Client ID" value={googleClientId} />}
              <ReviewRow label="Webhook Tenant" value={selectedTenantId || "(none)"} />
              <ReviewRow label="K8s Namespace" value={k8sNamespace || "(none)"} />
            </div>
            {submitError && (
              <div
                role="alert"
                style={{
                  padding: "0.5rem 0.75rem",
                  marginTop: "1rem",
                  background: "var(--color-danger-bg)",
                  color: "var(--color-danger)",
                  border: "1px solid var(--color-danger)",
                  borderRadius: 8,
                  fontSize: "0.85rem",
                }}
              >
                {submitError}
              </div>
            )}
          </>
        );
    }
  }

  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;
  const isSkippable = currentStep === "github" || currentStep === "oauth" || currentStep === "tenant" || currentStep === "k8s";

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      background: "var(--color-canvas)",
      padding: "2rem 1rem",
    }}>
      <div style={{
        width: 520,
        maxWidth: "100%",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 12,
        padding: "2rem",
      }}>
        <StepIndicator steps={STEPS} current={step} />

        {renderStep()}

        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "1.5rem",
          gap: "0.5rem",
        }}>
          <div>
            {!isFirst && (
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
                ← Back
              </Button>
            )}
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            {isSkippable && !isLast && (
              <Button variant="ghost" onClick={() => setStep((s) => s + 1)}>
                Skip
              </Button>
            )}
            {isLast ? (
              <Button onClick={handleFinish} loading={submitting} disabled={submitting}>
                Finish Setup
              </Button>
            ) : (
              <Button onClick={() => setStep((s) => s + 1)} disabled={!canAdvance()}>
                Next →
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
