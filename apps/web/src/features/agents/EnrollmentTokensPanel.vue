<script setup lang="ts">
import { onMounted, ref, type CSSProperties } from "vue";
import { Key } from "lucide-vue-next";
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
type AgentRuntime = "docker" | "shell" | "kubernetes" | "podman";
type InstallTab = "linux" | "kubernetes";

const ENROLLMENT_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const ENROLLMENT_PRESET_SECONDS: Record<EnrollmentTokenPreset, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60
};

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  docker: "Docker",
  shell: "Shell (host processes)",
  kubernetes: "Kubernetes",
  podman: "Podman"
};
const RUNTIME_OPTIONS: AgentRuntime[] = ["docker", "shell", "kubernetes", "podman"];

function formatDateTimeLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mn = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${mn}`;
}
function toPresetExpiration(preset: EnrollmentTokenPreset): string {
  return formatDateTimeLocal(new Date(Date.now() + ENROLLMENT_PRESET_SECONDS[preset] * 1000));
}
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

// Defaults for the operator quickstart. The agent name + namespace are
// editable from the UI so two KaiadAgents can coexist in the same namespace
// without sharing a Secret. The Secret name is derived from the agent name
// (`<agent>-enrollment`) so each CR gets a per-agent Secret automatically.
// The image defaults to Kaiad's own registry path so a fresh install pulls
// the agent from the same host that serves the panel — no external registry
// required.
const DEFAULT_KUBE_AGENT_NAME = "edge-agent";
const DEFAULT_KUBE_NAMESPACE = "kaiad-system";
const KUBE_SECRET_KEY = "token";

// Operator install bundle defaults. The operator runs in its own namespace
// (separate from any agent's namespace). Its image is pulled from this
// Kaiad's built-in registry by default (same host as the agent image),
// so clusters don't need GHCR access to install the operator.
const DEFAULT_OPERATOR_NAMESPACE = "kaiad-system";

function defaultOperatorImage(): string {
  if (typeof window === "undefined") {
    return "panel.example.com/kaiad-operator:latest";
  }
  // Mirrors defaultAgentImage(): window.location.host already includes any
  // non-standard port; for HTTPS prod this is the panel host that routes
  // /v2/ to the Kaiad-hosted registry.
  return `${window.location.host}/kaiad-operator:latest`;
}

function buildOperatorInstallUrl(opts: { namespace: string; image: string }): string {
  const params = new URLSearchParams();
  const ns = opts.namespace.trim() || DEFAULT_OPERATOR_NAMESPACE;
  const img = opts.image.trim() || defaultOperatorImage();
  if (ns !== DEFAULT_OPERATOR_NAMESPACE) params.set("namespace", ns);
  // Always pin the image: the server-side install.yaml default is the
  // GHCR build and it can't derive this panel's host, so the registry
  // image must be passed explicitly.
  params.set("image", img);
  const qs = params.toString();
  return `/api/v1/operator/install.yaml${qs ? `?${qs}` : ""}`;
}

function buildOperatorInstallAbsoluteUrl(opts: { namespace: string; image: string }): string {
  const path = buildOperatorInstallUrl(opts);
  if (typeof window === "undefined") return `https://your-kaiad.example.com${path}`;
  return `${window.location.protocol}//${window.location.host}${path}`;
}

function buildOperatorApplyCommand(opts: { namespace: string; image: string }): string {
  return `kubectl apply -f ${buildOperatorInstallAbsoluteUrl(opts)}`;
}

function defaultAgentImage(): string {
  if (typeof window === "undefined") {
    return "panel.example.com/kaiad-agent:latest";
  }
  // window.location.host already includes any non-standard port (e.g.
  // localhost:3001 in dev). For HTTPS production this is `panel.dev.kaiad.dev`
  // which routes /v2/ to the registry container via kaiad-proxy.
  return `${window.location.host}/kaiad-agent:latest`;
}

function deriveSecretName(agentName: string): string {
  const base = agentName.trim() || DEFAULT_KUBE_AGENT_NAME;
  return `${base}-enrollment`;
}

function derivePullSecretName(agentName: string): string {
  const base = agentName.trim() || DEFAULT_KUBE_AGENT_NAME;
  return `${base}-pull`;
}

function defaultRegistryHost(): string {
  if (typeof window === "undefined") return "panel.example.com";
  return window.location.host;
}

function buildKaiadAgentManifest(opts: {
  serviceId?: string | null;
  agentName: string;
  namespace: string;
  image: string;
}): string {
  const realtimeUrl =
    typeof window === "undefined"
      ? "wss://your-kaiad.example.com/realtime"
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/realtime`;
  const image = opts.image.trim() || defaultAgentImage();
  const serviceId = opts.serviceId?.trim();
  const agentName = opts.agentName.trim() || DEFAULT_KUBE_AGENT_NAME;
  const namespace = opts.namespace.trim() || DEFAULT_KUBE_NAMESPACE;
  const secretName = deriveSecretName(agentName);
  const lines = [
    "apiVersion: kaiad.dev/v1alpha1",
    "kind: KaiadAgent",
    "metadata:",
    `  name: ${agentName}`,
    `  namespace: ${namespace}`,
    "spec:",
    "  controlPlane:",
    `    realtimeUrl: ${realtimeUrl}`,
    "  enrollment:",
    "    secretRef:",
    `      name: ${secretName}`,
    `      key: ${KUBE_SECRET_KEY}`,
    `  image: ${image}`,
    "  imagePullSecrets:",
    `    - name: ${derivePullSecretName(agentName)}`,
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

// kubectl one-liner that drops the freshly-minted token into the Secret
// the agent's KaiadAgent.spec.enrollment.secretRef points at. The Secret
// is named per agent (`<agent>-enrollment`) so multiple agents in the
// same namespace don't collide. Single-quoted to keep dollar signs /
// shell metacharacters literal.
function buildKubectlCreateSecretCommand(opts: {
  token: string;
  agentName: string;
  namespace: string;
}): string {
  const agentName = opts.agentName.trim() || DEFAULT_KUBE_AGENT_NAME;
  const namespace = opts.namespace.trim() || DEFAULT_KUBE_NAMESPACE;
  const secretName = deriveSecretName(agentName);
  return `kubectl -n ${namespace} create secret generic ${secretName} --from-literal=${KUBE_SECRET_KEY}='${opts.token}'`;
}

// kubectl one-liner that creates the dockerconfigjson Secret kubelet
// uses to authenticate against the kaiad-hosted registry. Same token
// the agent consumes (the kaiad token-auth service grants `pull` to
// any active enrollment token without consuming it). The Secret is
// named per agent (`<agent>-pull`) and referenced via the CR's
// spec.imagePullSecrets.
function buildKubectlCreatePullSecretCommand(opts: {
  token: string;
  agentName: string;
  namespace: string;
  registryHost: string;
}): string {
  const agentName = opts.agentName.trim() || DEFAULT_KUBE_AGENT_NAME;
  const namespace = opts.namespace.trim() || DEFAULT_KUBE_NAMESPACE;
  const pullName = derivePullSecretName(agentName);
  const host = opts.registryHost.trim() || defaultRegistryHost();
  return (
    `kubectl -n ${namespace} create secret docker-registry ${pullName} ` +
    `--docker-server=${host} ` +
    `--docker-username=kaiad-agent ` +
    `--docker-password='${opts.token}'`
  );
}

function buildAgentStartCommand(token: string, serviceId?: string | null, runtime: AgentRuntime = "docker"): string {
  const realtimeUrl =
    typeof window === "undefined"
      ? "wss://your-kaiad.example.com/realtime"
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/realtime`;
  const trimmed = serviceId?.trim();
  const serviceClause = trimmed ? `SM_SERVICE_ID=${trimmed} ` : "";
  const runtimeClause = runtimeEnvClause(runtime);
  return `SM_REALTIME_URL=${realtimeUrl} NODE_ENV=production SM_ENROLLMENT_TOKEN=${token} ${serviceClause}${runtimeClause}/usr/local/bin/agent`;
}

const installTab = ref<InstallTab>("linux");
const yamlCopyMessage = ref<string | null>(null);
const tokens = ref<TokenInfo[]>([]);
const services = ref<MonitoredService[]>([]);
const selectedPreset = ref<EnrollmentTokenPreset>("24h");
const expiresAtInput = ref<string>(toPresetExpiration("24h"));
const selectedServiceId = ref<string>("");
const latestServiceId = ref<string>("");
const selectedRuntime = ref<AgentRuntime>("docker");
const latestRuntime = ref<AgentRuntime>("docker");
const isGeneratingToken = ref(false);
const deletingTokenId = ref<string | null>(null);
const deactivatingTokenId = ref<string | null>(null);
const tokenError = ref<string | null>(null);
const latestToken = ref<string | null>(null);
const copyMessage = ref<string | null>(null);
const commandCopyMessage = ref<string | null>(null);
const kubectlCopyMessage = ref<string | null>(null);
const pullSecretCopyMessage = ref<string | null>(null);
const kubeAgentName = ref<string>(DEFAULT_KUBE_AGENT_NAME);
const kubeNamespace = ref<string>(DEFAULT_KUBE_NAMESPACE);
const kubeImage = ref<string>(defaultAgentImage());
const operatorNamespace = ref<string>(DEFAULT_OPERATOR_NAMESPACE);
const operatorImage = ref<string>(defaultOperatorImage());
const operatorApplyCopyMessage = ref<string | null>(null);
// We render only ACTIVE tokens by default. A long-lived tenant can have
// thousands of expired/used tokens; rendering them all blocks the main
// thread. The user can opt in via the "Show inactive" button.
const includeInactive = ref(false);
const loadingInactive = ref(false);

async function loadTokens() {
  try {
    const r = await api.listEnrollmentTokens({ includeInactive: includeInactive.value });
    tokens.value = r.tokens;
  } catch {
    /* ignore */
  }
}

async function toggleInactive() {
  loadingInactive.value = true;
  includeInactive.value = !includeInactive.value;
  try {
    await loadTokens();
  } finally {
    loadingInactive.value = false;
  }
}

onMounted(async () => {
  await loadTokens();
  try {
    const r = await api.listServices();
    services.value = r.services;
  } catch {
    /* ignore */
  }
});

function onPresetChange(e: Event) {
  const preset = (e.target as HTMLSelectElement).value as EnrollmentTokenPreset;
  selectedPreset.value = preset;
  expiresAtInput.value = toPresetExpiration(preset);
}

async function handleGenerateEnrollmentToken() {
  tokenError.value = null;
  latestToken.value = null;
  copyMessage.value = null;
  commandCopyMessage.value = null;

  const expiration = new Date(expiresAtInput.value);
  if (!expiresAtInput.value || Number.isNaN(expiration.getTime())) {
    tokenError.value = "Choose a valid expiration date and time.";
    return;
  }
  const ttlSeconds = Math.floor((expiration.getTime() - Date.now()) / 1000);
  if (ttlSeconds <= 0) {
    tokenError.value = "Expiration must be in the future.";
    return;
  }
  if (ttlSeconds > ENROLLMENT_MAX_TTL_SECONDS) {
    tokenError.value = "Expiration cannot be more than 365 days from now.";
    return;
  }

  isGeneratingToken.value = true;
  try {
    const created = await api.createEnrollmentToken({ ttlSeconds });
    const { token, ...metadata } = created;
    tokens.value = [metadata, ...tokens.value];
    latestToken.value = token;
    latestServiceId.value = selectedServiceId.value;
    latestRuntime.value = selectedRuntime.value;
  } catch (e) {
    tokenError.value = (e as Error).message;
  } finally {
    isGeneratingToken.value = false;
  }
}

async function handleCopyToken() {
  if (!latestToken.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(latestToken.value);
    copyMessage.value = "Copied token to clipboard.";
  } catch {
    copyMessage.value = "Unable to copy token automatically.";
  }
}

async function handleCopyStartCommand() {
  if (!latestToken.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(
      buildAgentStartCommand(latestToken.value, latestServiceId.value, latestRuntime.value)
    );
    commandCopyMessage.value = "Copied command to clipboard.";
  } catch {
    commandCopyMessage.value = "Unable to copy command automatically.";
  }
}

async function handleCopyKubernetesYaml() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(
      buildKaiadAgentManifest({
        serviceId: selectedServiceId.value,
        agentName: kubeAgentName.value,
        namespace: kubeNamespace.value,
        image: kubeImage.value
      })
    );
    yamlCopyMessage.value = "Copied YAML to clipboard.";
  } catch {
    yamlCopyMessage.value = "Unable to copy YAML automatically.";
  }
}

async function handleCopyKubectlCommand() {
  if (!latestToken.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(
      buildKubectlCreateSecretCommand({
        token: latestToken.value,
        agentName: kubeAgentName.value,
        namespace: kubeNamespace.value
      })
    );
    kubectlCopyMessage.value = "Copied kubectl command to clipboard.";
  } catch {
    kubectlCopyMessage.value = "Unable to copy command automatically.";
  }
}

async function handleCopyOperatorApplyCommand() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(
      buildOperatorApplyCommand({
        namespace: operatorNamespace.value,
        image: operatorImage.value
      })
    );
    operatorApplyCopyMessage.value = "Copied kubectl command to clipboard.";
  } catch {
    operatorApplyCopyMessage.value = "Unable to copy command automatically.";
  }
}

async function handleCopyPullSecretCommand() {
  if (!latestToken.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(
      buildKubectlCreatePullSecretCommand({
        token: latestToken.value,
        agentName: kubeAgentName.value,
        namespace: kubeNamespace.value,
        registryHost: defaultRegistryHost()
      })
    );
    pullSecretCopyMessage.value = "Copied kubectl command to clipboard.";
  } catch {
    pullSecretCopyMessage.value = "Unable to copy command automatically.";
  }
}

function enrollmentTokenStatus(t: TokenInfo): string {
  if (t.isActive) return "Active";
  if (t.revokedAt && !t.usedAt) return "Revoked";
  if (t.usedAt) return "Used";
  return "Expired";
}

async function handleDeactivate(tokenId: string) {
  const t = tokens.value.find((entry) => entry.id === tokenId);
  if (!t || !t.isActive) return;
  if (!window.confirm("Deactivate this enrollment token? It will no longer work for new agent connections.")) return;
  tokenError.value = null;
  deactivatingTokenId.value = tokenId;
  try {
    await api.deactivateEnrollmentToken(tokenId);
    tokens.value = tokens.value.map((entry) =>
      entry.id === tokenId ? { ...entry, isActive: false, revokedAt: new Date().toISOString() } : entry
    );
  } catch (e) {
    tokenError.value = (e as Error).message;
  } finally {
    deactivatingTokenId.value = null;
  }
}

async function handleDelete(tokenId: string) {
  const t = tokens.value.find((entry) => entry.id === tokenId);
  if (!t || t.isActive) return;
  if (!window.confirm("Delete this inactive enrollment token?")) return;
  tokenError.value = null;
  deletingTokenId.value = tokenId;
  try {
    await api.deleteEnrollmentToken(tokenId);
    tokens.value = tokens.value.filter((token) => token.id !== tokenId);
  } catch (e) {
    tokenError.value = (e as Error).message;
  } finally {
    deletingTokenId.value = null;
  }
}

const sectionStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "10px",
  padding: "1rem",
  marginTop: "1.5rem"
};
const h3Style: CSSProperties = {
  margin: "0 0 0.75rem",
  fontSize: "1rem",
  display: "flex",
  alignItems: "center",
  gap: "0.4rem"
};
const mutedText: CSSProperties = { color: "var(--color-text-secondary)", margin: 0, fontSize: "0.85rem" };
function tabBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "var(--color-primary)" : "transparent",
    color: active ? "var(--color-primary-foreground)" : "var(--color-text-primary)",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    padding: "0.35rem 0.7rem",
    fontSize: "0.85rem",
    cursor: "pointer"
  };
}

// Shared styles for the kubernetes-tab quickstart form. Hoisted so the
// template stays readable and 4 inputs share visual treatment.
const kubeFieldset: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  padding: "0.5rem 0.85rem 0.85rem",
  margin: "0 0 0.65rem"
};
const kubeLegend: CSSProperties = {
  padding: "0 0.4rem",
  fontSize: "0.75rem",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--color-text-secondary)"
};
const kubeRow: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "end",
  flexWrap: "wrap"
};
const kubeFieldLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.8rem"
};
const kubeFieldHint: CSSProperties = { color: "var(--color-text-secondary)" };
const kubeInput: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  padding: "0.35rem 0.45rem",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)"
};
const kubeMonoInput: CSSProperties = {
  ...kubeInput,
  minWidth: "160px",
  fontFamily: "ui-monospace, monospace",
  fontSize: "0.8rem"
};
const kubeDerivedValue: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.35rem 0.55rem",
  background: "var(--color-surface-muted)",
  border: "1px dashed var(--color-border)",
  borderRadius: "6px",
  fontFamily: "ui-monospace, monospace",
  fontSize: "0.8rem",
  color: "var(--color-text-primary)",
  minHeight: "2rem"
};
function kubePrimaryBtn(disabled: boolean): CSSProperties {
  return {
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    border: "none",
    borderRadius: "6px",
    padding: "0.45rem 0.85rem",
    fontSize: "0.85rem",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.75 : 1
  };
}
const kubeStepHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  margin: "0.85rem 0 0.4rem",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--color-text-primary)"
};
const kubeStepBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "20px",
  height: "20px",
  borderRadius: "50%",
  background: "var(--color-primary)",
  color: "var(--color-primary-foreground)",
  fontSize: "0.72rem",
  fontWeight: 700
};
const kubeCommandBox: CSSProperties = {
  background: "var(--color-surface-muted)",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  padding: "0.65rem",
  fontFamily: "ui-monospace, monospace",
  fontSize: "0.78rem",
  overflowX: "auto",
  whiteSpace: "pre",
  margin: 0
};
const kubeCopyRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  marginTop: "0.5rem"
};
const kubeCopyBtn: CSSProperties = {
  background: "var(--color-surface)",
  color: "var(--color-text-primary)",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  padding: "0.35rem 0.65rem",
  fontSize: "0.8rem",
  cursor: "pointer"
};
</script>

<template>
  <div :style="sectionStyle">
    <h3 :style="h3Style"><Key :size="16" /> Enrollment Tokens</h3>
    <div role="tablist" aria-label="Install path" :style="{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem' }">
      <button
        type="button"
        role="tab"
        :aria-selected="installTab === 'linux'"
        :style="tabBtnStyle(installTab === 'linux')"
        @click="installTab = 'linux'"
      >Linux / VM</button>
      <button
        type="button"
        role="tab"
        :aria-selected="installTab === 'kubernetes'"
        :style="tabBtnStyle(installTab === 'kubernetes')"
        @click="installTab = 'kubernetes'"
      >Kubernetes (operator)</button>
    </div>

    <div v-if="installTab === 'kubernetes'" :style="{ marginBottom: '0.75rem' }">
      <p :style="mutedText">
        Install the operator once per cluster, then for each agent: name it (one CR per agent),
        generate a one-shot enrollment token, drop it into a <code>&lt;agent&gt;-enrollment</code> Secret,
        and apply the <code>KaiadAgent</code> resource. Each agent gets its own Secret so multiple
        agents in the same namespace don't share tokens. The agent consumes its token on first
        connect and persists its own credential.
      </p>

      <fieldset :style="kubeFieldset">
        <legend :style="kubeLegend">0 · Install operator (once per cluster)</legend>
        <p :style="{ ...mutedText, margin: '0 0 0.55rem' }">
          Apply the bundled YAML — CRD, namespace, ServiceAccount, ClusterRole,
          ClusterRoleBinding, and Deployment in a single file. Skip this step if
          the operator is already installed in this cluster.
        </p>
        <div :style="kubeRow">
          <label :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Operator namespace</span>
            <input
              v-model="operatorNamespace"
              aria-label="Operator namespace"
              :placeholder="DEFAULT_OPERATOR_NAMESPACE"
              :style="kubeMonoInput"
            />
          </label>
          <label :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Operator image</span>
            <input
              v-model="operatorImage"
              aria-label="Operator image"
              :placeholder="defaultOperatorImage()"
              :style="{ ...kubeMonoInput, minWidth: '380px' }"
            />
          </label>
        </div>
        <div :style="{ ...kubeCopyRow, marginTop: '0.65rem' }">
          <a
            :href="buildOperatorInstallUrl({ namespace: operatorNamespace, image: operatorImage })"
            download="kaiad-operator-install.yaml"
            :style="{
              ...kubePrimaryBtn(false),
              textDecoration: 'none',
              display: 'inline-block'
            }"
          >Download install.yaml</a>
          <button type="button" :style="kubeCopyBtn" @click="handleCopyOperatorApplyCommand">
            Copy kubectl apply command
          </button>
          <span
            v-if="operatorApplyCopyMessage"
            :style="{
              fontSize: '0.8rem',
              color: operatorApplyCopyMessage.startsWith('Copied') ? 'var(--color-success)' : 'var(--color-danger)'
            }"
          >{{ operatorApplyCopyMessage }}</span>
        </div>
        <pre
          aria-label="kubectl apply operator command"
          :style="{ ...kubeCommandBox, marginTop: '0.5rem' }"
        >{{ buildOperatorApplyCommand({ namespace: operatorNamespace, image: operatorImage }) }}</pre>
      </fieldset>

      <fieldset :style="kubeFieldset">
        <legend :style="kubeLegend">1 · Identity</legend>
        <div :style="kubeRow">
          <label :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Agent name</span>
            <input
              v-model="kubeAgentName"
              aria-label="Agent name (kubernetes)"
              :placeholder="DEFAULT_KUBE_AGENT_NAME"
              :style="kubeMonoInput"
            />
          </label>
          <label :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Namespace</span>
            <input
              v-model="kubeNamespace"
              aria-label="Namespace (kubernetes)"
              :placeholder="DEFAULT_KUBE_NAMESPACE"
              :style="kubeMonoInput"
            />
          </label>
          <div :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Will use Secret</span>
            <code :style="kubeDerivedValue">{{ deriveSecretName(kubeAgentName) }}</code>
          </div>
        </div>
        <label :style="{ ...kubeFieldLabel, marginTop: '0.65rem' }">
          <span :style="kubeFieldHint">
            Image
            <span :style="{ color: 'var(--color-text-muted)' }">— defaults to this Kaiad's built-in registry</span>
          </span>
          <input
            v-model="kubeImage"
            aria-label="Agent image (kubernetes)"
            :placeholder="defaultAgentImage()"
            :style="{ ...kubeMonoInput, minWidth: '420px' }"
          />
        </label>
      </fieldset>

      <fieldset :style="kubeFieldset">
        <legend :style="kubeLegend">2 · Token</legend>
        <div :style="kubeRow">
          <label :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Preset</span>
            <select
              :value="selectedPreset"
              aria-label="Token preset (kubernetes)"
              :style="kubeInput"
              @change="onPresetChange"
            >
              <option value="1h">1 hour</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </select>
          </label>
          <label :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Expires at</span>
            <input
              v-model="expiresAtInput"
              type="datetime-local"
              aria-label="Expires at (kubernetes)"
              :style="kubeInput"
            />
          </label>
          <label :style="kubeFieldLabel">
            <span :style="kubeFieldHint">Service this agent runs</span>
            <select
              v-model="selectedServiceId"
              aria-label="Service this agent runs (kubernetes)"
              :disabled="services.length === 0"
              :style="{ ...kubeInput, minWidth: '220px' }"
            >
              <option value="">{{ services.length === 0 ? "No services configured" : "Unbound (no service)" }}</option>
              <option v-for="svc in services" :key="svc.id" :value="svc.id">
                {{ svc.name }} ({{ svc.id }})
              </option>
            </select>
          </label>
          <button
            :disabled="isGeneratingToken"
            :style="kubePrimaryBtn(isGeneratingToken)"
            @click="handleGenerateEnrollmentToken"
          >{{ isGeneratingToken ? "Generating…" : latestToken ? "Regenerate token" : "Generate token" }}</button>
        </div>
      </fieldset>

      <p
        v-if="tokenError"
        :style="{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0.5rem 0 0' }"
      >{{ tokenError }}</p>

      <div v-if="latestToken">
        <div :style="kubeStepHeader">
          <span :style="kubeStepBadge">3</span>
          <span>Create the enrollment Secret in <code>{{ kubeNamespace.trim() || DEFAULT_KUBE_NAMESPACE }}</code></span>
          <span :style="{ fontSize: '0.72rem', fontWeight: 400, color: 'var(--color-text-secondary)' }">
            — agent reads this on first connect; token is shown once
          </span>
        </div>
        <pre
          aria-label="kubectl create secret command"
          :style="kubeCommandBox"
        >{{ buildKubectlCreateSecretCommand({ token: latestToken, agentName: kubeAgentName, namespace: kubeNamespace }) }}</pre>
        <div :style="kubeCopyRow">
          <button type="button" :style="kubeCopyBtn" @click="handleCopyKubectlCommand">Copy kubectl command</button>
          <span
            v-if="kubectlCopyMessage"
            :style="{
              fontSize: '0.8rem',
              color: kubectlCopyMessage.startsWith('Copied') ? 'var(--color-success)' : 'var(--color-danger)'
            }"
          >{{ kubectlCopyMessage }}</span>
        </div>

        <div :style="kubeStepHeader">
          <span :style="kubeStepBadge">4</span>
          <span>Create the image-pull Secret (kubelet uses it to authenticate against this Kaiad's registry)</span>
        </div>
        <pre
          aria-label="kubectl create pull secret command"
          :style="kubeCommandBox"
        >{{ buildKubectlCreatePullSecretCommand({ token: latestToken, agentName: kubeAgentName, namespace: kubeNamespace, registryHost: defaultRegistryHost() }) }}</pre>
        <div :style="kubeCopyRow">
          <button type="button" :style="kubeCopyBtn" @click="handleCopyPullSecretCommand">Copy kubectl command</button>
          <span
            v-if="pullSecretCopyMessage"
            :style="{
              fontSize: '0.8rem',
              color: pullSecretCopyMessage.startsWith('Copied') ? 'var(--color-success)' : 'var(--color-danger)'
            }"
          >{{ pullSecretCopyMessage }}</span>
        </div>
      </div>

      <div :style="kubeStepHeader">
        <span :style="kubeStepBadge">{{ latestToken ? '5' : '3' }}</span>
        <span>Apply the <code>KaiadAgent</code> resource</span>
        <span v-if="!latestToken" :style="{ fontSize: '0.72rem', fontWeight: 400, color: 'var(--color-text-secondary)' }">
          — preview; refreshes as you edit Identity above
        </span>
      </div>
      <pre
        aria-label="KaiadAgent YAML"
        :style="kubeCommandBox"
      >{{ buildKaiadAgentManifest({ serviceId: selectedServiceId, agentName: kubeAgentName, namespace: kubeNamespace, image: kubeImage }) }}</pre>
      <div :style="kubeCopyRow">
        <button type="button" :style="kubeCopyBtn" @click="handleCopyKubernetesYaml">Copy YAML</button>
        <span
          v-if="yamlCopyMessage"
          :style="{
            fontSize: '0.8rem',
            color: yamlCopyMessage.startsWith('Copied') ? 'var(--color-success)' : 'var(--color-danger)'
          }"
        >{{ yamlCopyMessage }}</span>
      </div>
    </div>

    <template v-if="installTab === 'linux'">
      <div :style="{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap', marginBottom: '0.75rem' }">
        <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem' }">
          <span :style="{ color: 'var(--color-text-secondary)' }">Preset</span>
          <select
            :value="selectedPreset"
            :style="{
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.35rem 0.45rem',
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)'
            }"
            @change="onPresetChange"
          >
            <option value="1h">1 hour</option>
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </select>
        </label>
        <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem' }">
          <span :style="{ color: 'var(--color-text-secondary)' }">Expires at</span>
          <input
            v-model="expiresAtInput"
            type="datetime-local"
            aria-label="Expires at"
            :style="{
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.35rem 0.45rem',
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)'
            }"
          />
        </label>
        <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem' }">
          <span :style="{ color: 'var(--color-text-secondary)' }">Service this agent runs</span>
          <select
            v-model="selectedServiceId"
            aria-label="Service this agent runs"
            :disabled="services.length === 0"
            :style="{
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.35rem 0.45rem',
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              minWidth: '220px'
            }"
          >
            <option value="">{{ services.length === 0 ? "No services configured" : "Unbound (no service)" }}</option>
            <option v-for="svc in services" :key="svc.id" :value="svc.id">
              {{ svc.name }} ({{ svc.id }})
            </option>
          </select>
        </label>
        <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem' }">
          <span :style="{ color: 'var(--color-text-secondary)' }">Runtime</span>
          <select
            v-model="selectedRuntime"
            aria-label="Agent runtime"
            :style="{
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.35rem 0.45rem',
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              minWidth: '160px'
            }"
          >
            <option v-for="r in RUNTIME_OPTIONS" :key="r" :value="r">{{ RUNTIME_LABELS[r] }}</option>
          </select>
        </label>
        <button
          :disabled="isGeneratingToken"
          :style="{
            background: 'var(--color-primary)',
            color: 'var(--color-primary-foreground)',
            border: 'none',
            borderRadius: '6px',
            padding: '0.45rem 0.8rem',
            fontSize: '0.85rem',
            cursor: isGeneratingToken ? 'not-allowed' : 'pointer',
            opacity: isGeneratingToken ? 0.75 : 1
          }"
          @click="handleGenerateEnrollmentToken"
        >{{ isGeneratingToken ? "Generating..." : "Generate token" }}</button>
      </div>

      <p
        v-if="tokenError"
        :style="{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0 0 0.75rem' }"
      >{{ tokenError }}</p>

      <div
        v-if="latestToken"
        :style="{
          marginBottom: '0.75rem',
          background: 'var(--color-surface-muted)',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          padding: '0.65rem'
        }"
      >
        <div :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: '0.35rem' }">
          New enrollment token (copy now - shown only once):
        </div>
        <code :style="{ display: 'block', fontSize: '0.8rem', wordBreak: 'break-all' }">{{ latestToken }}</code>
        <div :style="{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }">
          <button
            type="button"
            :style="{
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.35rem 0.65rem',
              fontSize: '0.8rem',
              cursor: 'pointer'
            }"
            @click="handleCopyToken"
          >Copy token</button>
          <span
            v-if="copyMessage"
            :style="{
              fontSize: '0.8rem',
              color: copyMessage.startsWith('Copied') ? 'var(--color-success)' : 'var(--color-danger)'
            }"
          >{{ copyMessage }}</span>
        </div>
        <div :style="{ marginTop: '0.65rem' }">
          <div :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: '0.35rem' }">
            Start command{{ latestServiceId ? ` (bound to ${latestServiceId})` : "" }} —
            {{ RUNTIME_LABELS[latestRuntime] }}:
          </div>
          <code :style="{ display: 'block', fontSize: '0.8rem', wordBreak: 'break-all' }">
            {{ buildAgentStartCommand(latestToken, latestServiceId, latestRuntime) }}
          </code>
          <div :style="{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }">
            <button
              type="button"
              :style="{
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                padding: '0.35rem 0.65rem',
                fontSize: '0.8rem',
                cursor: 'pointer'
              }"
              @click="handleCopyStartCommand"
            >Copy start command</button>
            <span
              v-if="commandCopyMessage"
              :style="{
                fontSize: '0.8rem',
                color: commandCopyMessage.startsWith('Copied') ? 'var(--color-success)' : 'var(--color-danger)'
              }"
            >{{ commandCopyMessage }}</span>
          </div>
        </div>
      </div>
    </template>

    <div :style="{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '0 0 0.5rem' }">
      <span :style="{ ...mutedText, fontSize: '0.78rem' }">
        Showing {{ tokens.length }} {{ includeInactive ? "" : "active " }}token{{ tokens.length === 1 ? "" : "s" }}{{
          includeInactive ? " (most recent first, capped at 500)" : ""
        }}
      </span>
      <button
        type="button"
        :disabled="loadingInactive"
        :style="{
          background: 'var(--color-surface-muted)',
          color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          padding: '0.25rem 0.55rem',
          fontSize: '0.75rem',
          cursor: loadingInactive ? 'wait' : 'pointer',
          opacity: loadingInactive ? 0.7 : 1
        }"
        @click="toggleInactive"
      >
        {{ loadingInactive ? "Loading…" : includeInactive ? "Hide inactive" : "Show inactive" }}
      </button>
    </div>

    <p v-if="tokens.length === 0" :style="mutedText">No enrollment tokens found.</p>

    <table v-else :style="{ width: '100%', borderCollapse: 'collapse' }">
      <thead>
        <tr>
          <th
            v-for="h in ['ID', 'Status', 'Expires', 'Created By', 'Used', 'Actions']"
            :key="h"
            :style="{
              textAlign: 'left',
              padding: '0.4rem',
              borderBottom: '1px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
              fontSize: '0.8rem'
            }"
          >{{ h }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in tokens" :key="t.id">
          <td :style="{ padding: '0.4rem', fontSize: '0.8rem', fontFamily: 'monospace' }">
            {{ t.id.slice(0, 12) }}...
          </td>
          <td :style="{ padding: '0.4rem', fontSize: '0.8rem' }">{{ enrollmentTokenStatus(t) }}</td>
          <td :style="{ padding: '0.4rem', fontSize: '0.8rem' }">{{ new Date(t.expiresAt).toLocaleString() }}</td>
          <td :style="{ padding: '0.4rem', fontSize: '0.8rem' }">{{ t.createdBy }}</td>
          <td :style="{ padding: '0.4rem', fontSize: '0.8rem' }">{{ t.usedAt ? "Yes" : "No" }}</td>
          <td :style="{ padding: '0.4rem', fontSize: '0.8rem' }">
            <div :style="{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }">
              <button
                type="button"
                :aria-label="`Deactivate token ${t.id}`"
                :disabled="deactivatingTokenId === t.id || !t.isActive"
                :style="{
                  background: 'var(--color-surface-muted)',
                  color: 'var(--color-text-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '6px',
                  padding: '0.3rem 0.55rem',
                  fontSize: '0.75rem',
                  cursor: deactivatingTokenId === t.id || !t.isActive ? 'not-allowed' : 'pointer',
                  opacity: deactivatingTokenId === t.id || !t.isActive ? 0.7 : 1
                }"
                @click="handleDeactivate(t.id)"
              >{{ deactivatingTokenId === t.id ? "Deactivating..." : "Deactivate" }}</button>
              <button
                type="button"
                :aria-label="`Delete token ${t.id}`"
                :disabled="deletingTokenId === t.id || t.isActive"
                :style="{
                  background: 'var(--color-danger-bg)',
                  color: 'var(--color-danger)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '6px',
                  padding: '0.3rem 0.55rem',
                  fontSize: '0.75rem',
                  cursor: deletingTokenId === t.id || t.isActive ? 'not-allowed' : 'pointer',
                  opacity: deletingTokenId === t.id || t.isActive ? 0.7 : 1
                }"
                @click="handleDelete(t.id)"
              >{{ deletingTokenId === t.id ? "Deleting..." : "Delete" }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
