import { useEffect, useState, type CSSProperties } from "react";
import { Key } from "lucide-react";
import { api, type MonitoredService } from "../../lib/api.js";

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
type EnrollmentTokenPreset = "1h" | "24h" | "7d" | "30d";

const ENROLLMENT_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const ENROLLMENT_PRESET_SECONDS: Record<EnrollmentTokenPreset, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60
};

const sectionStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  padding: "1rem",
  marginTop: "1.5rem"
};

const h3Style: CSSProperties = { margin: "0 0 0.75rem", fontSize: "1rem", display: "flex", alignItems: "center", gap: "0.4rem" };
const mutedText: CSSProperties = { color: "var(--color-text-secondary)", margin: 0, fontSize: "0.85rem" };

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

export type AgentRuntime = "docker" | "shell" | "kubernetes" | "podman";

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  docker: "Docker",
  shell: "Shell (host processes)",
  kubernetes: "Kubernetes",
  podman: "Podman"
};

const RUNTIME_OPTIONS: AgentRuntime[] = ["docker", "shell", "kubernetes", "podman"];

function runtimeEnvClause(runtime: AgentRuntime): string {
  switch (runtime) {
    case "docker":
      return "";
    case "shell":
      return "SM_AGENT_RUNTIME_OVERRIDE=shell ";
    case "kubernetes":
      return "SM_AGENT_RUNTIME_OVERRIDE=kubernetes ";
    case "podman":
      return "SM_DOCKER_SOCKET=/run/podman/podman.sock ";
  }
}

export function buildKaiadAgentManifest(opts: {
  name?: string;
  namespace?: string;
  realtimeUrl?: string;
  serviceId?: string | null;
  image?: string;
}): string {
  const realtimeUrl =
    opts.realtimeUrl ??
    (typeof window === "undefined"
      ? "wss://your-kaiad.example.com/realtime"
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/realtime`);
  const name = opts.name ?? "edge-agent";
  const namespace = opts.namespace ?? "kaiad-system";
  const image = opts.image ?? "ghcr.io/innkeeperdevops/kaiad-agent:latest";
  const serviceId = opts.serviceId?.trim();
  const lines = [
    "apiVersion: kaiad.dev/v1alpha1",
    "kind: KaiadAgent",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    "spec:",
    "  controlPlane:",
    `    realtimeUrl: ${realtimeUrl}`,
    "  enrollment:",
    "    autoMint: true",
    `  image: ${image}`,
    ...(serviceId ? [`  serviceId: ${serviceId}`] : []),
    "  manages:",
    "    - apiGroups: [\"apps\"]",
    "      resources: [\"deployments\", \"statefulsets\"]",
    "      verbs: [\"get\", \"list\", \"watch\", \"patch\", \"update\"]",
    "      namespaceSelector:",
    "        matchLabels:",
    "          kaiad.dev/managed: \"true\"",
    "    - apiGroups: [\"\"]",
    "      resources: [\"pods\", \"pods/log\"]",
    "      verbs: [\"get\", \"list\", \"watch\"]",
    "      namespaceSelector:",
    "        matchLabels:",
    "          kaiad.dev/managed: \"true\""
  ];
  return lines.join("\n") + "\n";
}

export function buildAgentStartCommand(
  token: string,
  serviceId?: string | null,
  runtime: AgentRuntime = "docker"
): string {
  const realtimeUrl =
    typeof window === "undefined"
      ? "wss://your-kaiad.example.com/realtime"
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/realtime`;
  const trimmed = serviceId?.trim();
  const serviceClause = trimmed ? `SM_SERVICE_ID=${trimmed} ` : "";
  const runtimeClause = runtimeEnvClause(runtime);
  return `SM_REALTIME_URL=${realtimeUrl} NODE_ENV=production SM_ENROLLMENT_TOKEN=${token} ${serviceClause}${runtimeClause}/usr/local/bin/agent`;
}

type InstallTab = "linux" | "kubernetes";

export function EnrollmentTokensPanel() {
  const [installTab, setInstallTab] = useState<InstallTab>("linux");
  const [yamlCopyMessage, setYamlCopyMessage] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<EnrollmentTokenPreset>("24h");
  const [expiresAtInput, setExpiresAtInput] = useState<string>(() => toPresetExpiration("24h"));
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [latestServiceId, setLatestServiceId] = useState<string>("");
  const [selectedRuntime, setSelectedRuntime] = useState<AgentRuntime>("docker");
  const [latestRuntime, setLatestRuntime] = useState<AgentRuntime>("docker");
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const [deactivatingTokenId, setDeactivatingTokenId] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [latestToken, setLatestToken] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [commandCopyMessage, setCommandCopyMessage] = useState<string | null>(null);

  useEffect(() => {
    api.listEnrollmentTokens().then((r) => setTokens(r.tokens)).catch(() => {});
    api.listServices().then((r) => setServices(r.services)).catch(() => {});
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
      setLatestServiceId(selectedServiceId);
      setLatestRuntime(selectedRuntime);
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
      await navigator.clipboard.writeText(buildAgentStartCommand(latestToken, latestServiceId, latestRuntime));
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
    } catch (e) {
      setTokenError((e as Error).message);
    } finally {
      setDeletingTokenId(null);
    }
  }

  const tabBtnStyle = (active: boolean): CSSProperties => ({
    background: active ? "var(--color-primary)" : "transparent",
    color: active ? "var(--color-primary-foreground)" : "var(--color-text-primary)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    padding: "0.35rem 0.7rem",
    fontSize: "0.85rem",
    cursor: "pointer"
  });

  async function handleCopyKubernetesYaml() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(buildKaiadAgentManifest({ serviceId: selectedServiceId }));
      setYamlCopyMessage("Copied YAML to clipboard.");
    } catch {
      setYamlCopyMessage("Unable to copy YAML automatically.");
    }
  }

  return (
    <div style={sectionStyle}>
      <h3 style={h3Style}><Key size={16} /> Enrollment Tokens</h3>
      <div role="tablist" aria-label="Install path" style={{ display: "flex", gap: "0.4rem", marginBottom: "0.75rem" }}>
        <button
          type="button"
          role="tab"
          aria-selected={installTab === "linux"}
          onClick={() => setInstallTab("linux")}
          style={tabBtnStyle(installTab === "linux")}
        >
          Linux / VM
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={installTab === "kubernetes"}
          onClick={() => setInstallTab("kubernetes")}
          style={tabBtnStyle(installTab === "kubernetes")}
        >
          Kubernetes (operator)
        </button>
      </div>

      {installTab === "kubernetes" && (
        <div style={{ marginBottom: "0.75rem" }}>
          <p style={mutedText}>
            Install the operator once per cluster, then apply this <code>KaiadAgent</code> resource. The operator
            mints a short-TTL enrollment token via the Kaiad API on your behalf — no need to copy a token here.
          </p>
          <pre
            aria-label="KaiadAgent YAML"
            style={{
              background: "var(--color-surface-muted)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: "0.65rem",
              fontSize: "0.78rem",
              overflowX: "auto",
              margin: "0.5rem 0"
            }}
          >
{buildKaiadAgentManifest({ serviceId: selectedServiceId })}
          </pre>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void handleCopyKubernetesYaml()}
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
              Copy YAML
            </button>
            {yamlCopyMessage && (
              <span style={{ fontSize: "0.8rem", color: yamlCopyMessage.startsWith("Copied") ? "var(--color-success)" : "var(--color-danger)" }}>
                {yamlCopyMessage}
              </span>
            )}
            <span style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)" }}>
              Pair the YAML with a service binding by selecting a service below.
            </span>
          </div>
        </div>
      )}

      {installTab === "linux" && (
      <>
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
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.8rem" }}>
          <span style={{ color: "var(--color-text-secondary)" }}>Service this agent runs</span>
          <select
            aria-label="Service this agent runs"
            value={selectedServiceId}
            onChange={(e) => setSelectedServiceId(e.target.value)}
            disabled={services.length === 0}
            style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.35rem 0.45rem", background: "var(--color-surface)", color: "var(--color-text-primary)", minWidth: 220 }}
          >
            <option value="">
              {services.length === 0 ? "No services configured" : "Unbound (no service)"}
            </option>
            {services.map((svc) => (
              <option key={svc.id} value={svc.id}>
                {svc.name} ({svc.id})
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.8rem" }}>
          <span style={{ color: "var(--color-text-secondary)" }}>Runtime</span>
          <select
            aria-label="Agent runtime"
            value={selectedRuntime}
            onChange={(e) => setSelectedRuntime(e.target.value as AgentRuntime)}
            style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.35rem 0.45rem", background: "var(--color-surface)", color: "var(--color-text-primary)", minWidth: 160 }}
          >
            {RUNTIME_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {RUNTIME_LABELS[r]}
              </option>
            ))}
          </select>
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
              Start command{latestServiceId ? ` (bound to ${latestServiceId})` : ""} —{" "}
              {RUNTIME_LABELS[latestRuntime]}:
            </div>
            <code style={{ display: "block", fontSize: "0.8rem", wordBreak: "break-all" }}>
              {buildAgentStartCommand(latestToken, latestServiceId, latestRuntime)}
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
      </>
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
  );
}
