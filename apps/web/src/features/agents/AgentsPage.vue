<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type CSSProperties } from "vue";
import { Cpu, RefreshCw } from "lucide-vue-next";
import {
  api,
  type Agent,
  type AgentTelemetry,
  type MonitoredService,
  type ServiceBuild
} from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import Badge from "../../components/Badge.vue";
import Button from "../../components/Button.vue";
import { useTelemetryStream } from "./useTelemetryStream.js";
import EnrollmentTokensPanel from "./EnrollmentTokensPanel.vue";
import {
  AGENT_STATUS_BADGE,
  badgeVariantForStatus,
  formatRelativeTime,
  formatRuntimeBackend
} from "./format.js";

const POLL_INTERVAL_MS = 30_000;

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.8rem",
  fontWeight: 600
};
const tdStyle: CSSProperties = { padding: "0.5rem", verticalAlign: "middle" };

const auth = useAuth();
const isViewer = computed(() => auth.value.isViewer);

const agents = ref<Agent[]>([]);
const services = ref<MonitoredService[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const lastUpdated = ref<Date | null>(null);
const secondsAgo = ref(0);

const live = useTelemetryStream(() => true);

async function fetchData() {
  error.value = null;
  try {
    const [ar, sr] = await Promise.all([api.listAgents(), api.listServices()]);
    agents.value = ar.agents;
    services.value = sr.services;
    lastUpdated.value = new Date();
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

let pollId: ReturnType<typeof setInterval> | null = null;
let secId: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void fetchData();
  pollId = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
  secId = setInterval(() => {
    if (lastUpdated.value) {
      secondsAgo.value = Math.floor((Date.now() - lastUpdated.value.getTime()) / 1000);
    }
  }, 1000);
});
onUnmounted(() => {
  if (pollId) clearInterval(pollId);
  if (secId) clearInterval(secId);
});

// Number of services bound to each agent — keeps the list informative
// without rendering the full ServicesForAgentSection inline.
const serviceCountByAgent = computed(() => {
  const m = new Map<string, number>();
  for (const s of services.value) {
    for (const b of s.agents ?? []) {
      m.set(b.agentId, (m.get(b.agentId) ?? 0) + 1);
    }
  }
  return m;
});

// ── Per-agent deploy: pick a bound service + version → this agent ──
const canDeploy = computed(() => !isViewer.value);
const deployFor = ref<string | null>(null); // open panel's agentId
const deploySvcId = ref<string>("");
const deployBuilds = ref<ServiceBuild[]>([]);
const deployBuildId = ref<string>("");
const deployBuildsLoading = ref(false);
const deploying = ref(false);
const deployMsg = ref<string | null>(null);
const deployErr = ref<string | null>(null);

function boundServicesFor(agentId: string): MonitoredService[] {
  return services.value.filter((s) => (s.agents ?? []).some((b) => b.agentId === agentId));
}

function toggleDeploy(agentId: string) {
  if (deployFor.value === agentId) {
    deployFor.value = null;
    return;
  }
  deployFor.value = agentId;
  deploySvcId.value = "";
  deployBuilds.value = [];
  deployBuildId.value = "";
  deployMsg.value = null;
  deployErr.value = null;
}

async function onDeployServiceChange() {
  deployBuilds.value = [];
  deployBuildId.value = "";
  deployMsg.value = null;
  deployErr.value = null;
  if (!deploySvcId.value) return;
  deployBuildsLoading.value = true;
  try {
    const r = await api.listServiceBuilds(deploySvcId.value);
    deployBuilds.value = r.builds.filter((b) => b.status === "success" && !!b.imageRef);
    deployBuildId.value = deployBuilds.value[0]?.id ?? "";
  } catch (e: unknown) {
    deployErr.value = (e as Error).message;
  } finally {
    deployBuildsLoading.value = false;
  }
}

function deployBuildLabel(b: ServiceBuild): string {
  const sha = b.gitSha ? b.gitSha.slice(0, 12) : "(no sha)";
  const when = new Date(b.startedAt ?? b.createdAt).toLocaleString();
  const img = b.imageRef ? b.imageRef.split("/").slice(-1)[0] : "";
  return img ? `${sha} · ${when} · ${img}` : `${sha} · ${when}`;
}

async function submitAgentDeploy(agentId: string) {
  if (deploying.value || !canDeploy.value) return;
  if (!deploySvcId.value || !deployBuildId.value) return;
  deploying.value = true;
  deployMsg.value = null;
  deployErr.value = null;
  try {
    const r = await api.deployToAgent(agentId, deploySvcId.value, deployBuildId.value);
    const offline = r.results.filter((x) => x.queued && !x.delivered).length;
    deployMsg.value =
      r.dispatched > 0
        ? `Deployed${offline > 0 ? " (queued — agent offline)" : " to the agent"}.`
        : r.skipped.length > 0
          ? `Skipped: ${r.skipped.join("; ")}`
          : "No command dispatched.";
  } catch (e: unknown) {
    deployErr.value = (e as Error).message;
  } finally {
    deploying.value = false;
  }
}

// Merge live telemetry presence into the static row data so "Live"
// reflects the WebSocket state in real time. Sorted by display name
// (falling back to id when unnamed) so order is stable across renders
// and the API's natural ordering doesn't reshuffle rows on refetch.
const displayedAgents = computed<Agent[]>(() =>
  agents.value
    .map((a) => {
      const liveHost: AgentTelemetry | undefined = live.host[a.id];
      const livePresence = live.presence[a.id];
      return {
        ...a,
        ...(liveHost ? { telemetry: liveHost } : {}),
        websocketConnected: livePresence !== undefined ? livePresence : a.websocketConnected
      };
    })
    .sort((a, b) => {
      const an = (a.name?.trim() || a.id).toLowerCase();
      const bn = (b.name?.trim() || b.id).toLowerCase();
      return an.localeCompare(bn);
    })
);

const summary = computed(() => {
  let liveWs = 0;
  const byStatus: Record<string, number> = { online: 0, degraded: 0, offline: 0, unknown: 0 };
  for (const a of displayedAgents.value) {
    if (a.websocketConnected) liveWs += 1;
    const k = a.status in byStatus ? a.status : "unknown";
    byStatus[k] = (byStatus[k] ?? 0) + 1;
  }
  return { liveWs, byStatus };
});
</script>

<template>
  <section>
    <div :style="{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }">
      <h2 :style="{ margin: 0 }">Connected Agents</h2>
      <div :style="{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.75rem' }">
        <Badge :variant="live.connected ? 'success' : 'muted'">
          {{ live.connected ? "Live stream" : "Reconnecting…" }}
        </Badge>
        <span v-if="lastUpdated" :style="{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">
          Last updated: {{ secondsAgo }}s ago
        </span>
        <Button size="sm" variant="ghost" :disabled="loading" @click="fetchData">
          <RefreshCw :size="14" /> Refresh
        </Button>
      </div>
    </div>

    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.75rem' }" role="alert">{{ error }}</div>

    <p v-if="loading" :style="{ color: 'var(--color-text-secondary)', margin: '0 0 1rem' }">Loading…</p>

    <div
      v-if="!loading && !error && displayedAgents.length > 0"
      :style="{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        alignItems: 'center',
        marginBottom: '1rem',
        fontSize: '0.85rem',
        color: 'var(--color-text-secondary)'
      }"
    >
      <span>
        <strong :style="{ color: 'var(--color-text-primary)' }">{{ displayedAgents.length }}</strong>
        agent{{ displayedAgents.length === 1 ? "" : "s" }}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <strong :style="{ color: 'var(--color-text-primary)' }">{{ summary.liveWs }}</strong> live (WebSocket)
      </span>
      <template v-for="st in (['online', 'degraded', 'offline', 'unknown'] as const)" :key="st">
        <Badge v-if="summary.byStatus[st] > 0" :variant="AGENT_STATUS_BADGE[st] ?? 'muted'">
          {{ st }}: {{ summary.byStatus[st] }}
        </Badge>
      </template>
    </div>

    <p
      v-if="!loading && !error && displayedAgents.length === 0"
      :style="{ color: 'var(--color-text-secondary)', margin: 0 }"
    >
      No agents connected.
      <template v-if="isViewer">Ask an administrator to create an enrollment token.</template>
      <template v-else>Use the panel below to create an enrollment token and register an agent.</template>
    </p>

    <div v-if="!loading && !error && displayedAgents.length > 0" :style="{ overflowX: 'auto' }">
      <table :style="{ width: '100%', borderCollapse: 'collapse', minWidth: '760px' }">
        <thead>
          <tr>
            <th scope="col" :style="thStyle">Agent</th>
            <th scope="col" :style="thStyle">Live</th>
            <th scope="col" :style="thStyle">Status</th>
            <th scope="col" :style="thStyle">Runtime</th>
            <th scope="col" :style="thStyle">Environment</th>
            <th scope="col" :style="thStyle">Last seen</th>
            <th scope="col" :style="thStyle">Services</th>
            <th v-if="canDeploy" scope="col" :style="thStyle">Deploy</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="a in displayedAgents" :key="a.id">
          <tr :style="{ borderTop: '1px solid var(--color-border)' }">
            <td :style="tdStyle">
              <a
                :href="`#agent/${encodeURIComponent(a.id)}`"
                :style="{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  color: 'var(--color-text-primary)',
                  textDecoration: 'none',
                  fontWeight: 600
                }"
              >
                <Cpu :size="14" aria-hidden />
                <span>{{ a.name?.trim() || a.id }}</span>
              </a>
              <div
                v-if="a.name?.trim()"
                :style="{
                  fontSize: '0.75rem',
                  color: 'var(--color-text-secondary)',
                  fontFamily: 'ui-monospace, monospace',
                  marginTop: '0.15rem'
                }"
              >{{ a.id }}</div>
            </td>
            <td :style="tdStyle">
              <Badge :variant="a.websocketConnected ? 'success' : 'muted'">
                {{ a.websocketConnected ? "Yes" : "No" }}
              </Badge>
            </td>
            <td :style="tdStyle">
              <Badge :variant="badgeVariantForStatus(a.status)">{{ a.status }}</Badge>
            </td>
            <td :style="tdStyle">
              <Badge :variant="a.runtimeBackend ? 'muted' : 'muted'">
                {{ formatRuntimeBackend(a.runtimeBackend) }}
              </Badge>
            </td>
            <td :style="{ ...tdStyle, fontSize: '0.85rem' }">
              <Badge variant="muted">{{ a.environment }}</Badge>
            </td>
            <td :style="{ ...tdStyle, fontSize: '0.85rem' }">
              <span :title="a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString() : undefined">
                {{ formatRelativeTime(a.lastSeenAt) }}
              </span>
            </td>
            <td :style="{ ...tdStyle, fontSize: '0.85rem' }">
              {{ serviceCountByAgent.get(a.id) ?? 0 }}
            </td>
            <td v-if="canDeploy" :style="tdStyle">
              <button
                type="button"
                :disabled="(serviceCountByAgent.get(a.id) ?? 0) === 0"
                :title="(serviceCountByAgent.get(a.id) ?? 0) === 0 ? 'No services bound to this agent' : 'Deploy a service version to this agent'"
                :style="{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  padding: '0.2rem 0.55rem',
                  background: deployFor === a.id ? 'var(--color-surface)' : 'var(--color-primary)',
                  color: deployFor === a.id ? 'var(--color-text)' : 'var(--color-primary-foreground)',
                  border: deployFor === a.id ? '1px solid var(--color-border)' : 'none',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  cursor: (serviceCountByAgent.get(a.id) ?? 0) === 0 ? 'not-allowed' : 'pointer',
                  opacity: (serviceCountByAgent.get(a.id) ?? 0) === 0 ? 0.5 : 1
                }"
                @click="toggleDeploy(a.id)"
              >
                {{ deployFor === a.id ? "Close" : "Deploy" }}
              </button>
            </td>
          </tr>
          <tr v-if="canDeploy && deployFor === a.id">
            <td :colspan="8" :style="{ ...tdStyle, background: 'var(--color-bg)' }">
              <div
                :style="{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  fontSize: '0.78rem'
                }"
              >
                <strong>Service</strong>
                <select
                  v-model="deploySvcId"
                  aria-label="Service to deploy"
                  :style="{
                    fontSize: '0.75rem',
                    padding: '0.2rem 0.35rem',
                    background: 'var(--color-surface)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '4px'
                  }"
                  @change="onDeployServiceChange"
                >
                  <option value="">Select a bound service…</option>
                  <option v-for="s in boundServicesFor(a.id)" :key="s.id" :value="s.id">
                    {{ s.name }}
                  </option>
                </select>

                <strong>Version</strong>
                <select
                  v-model="deployBuildId"
                  aria-label="Version to deploy"
                  :disabled="deployBuildsLoading || deployBuilds.length === 0"
                  :style="{
                    fontSize: '0.75rem',
                    padding: '0.2rem 0.35rem',
                    maxWidth: '320px',
                    background: 'var(--color-surface)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '4px'
                  }"
                >
                  <option v-if="deployBuildsLoading" value="">Loading versions…</option>
                  <option v-else-if="!deploySvcId" value="">Pick a service first</option>
                  <option v-else-if="deployBuilds.length === 0" value="">
                    No successful builds for this service
                  </option>
                  <option v-for="b in deployBuilds" :key="b.id" :value="b.id">
                    {{ deployBuildLabel(b) }}
                  </option>
                </select>

                <button
                  type="button"
                  :disabled="deploying || !deploySvcId || !deployBuildId"
                  :style="{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.2rem 0.6rem',
                    background: 'var(--color-primary)',
                    color: 'var(--color-primary-foreground)',
                    border: 'none',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    cursor: deploying || !deploySvcId || !deployBuildId ? 'not-allowed' : 'pointer',
                    opacity: deploying || !deploySvcId || !deployBuildId ? 0.6 : 1
                  }"
                  @click="submitAgentDeploy(a.id)"
                >
                  {{ deploying ? "Deploying…" : "Deploy to this agent" }}
                </button>

                <span v-if="deployMsg" :style="{ color: 'var(--color-text-secondary)' }">
                  {{ deployMsg }}
                </span>
                <span v-if="deployErr" :style="{ color: 'var(--color-danger)' }">
                  {{ deployErr }}
                </span>
              </div>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
    </div>

    <EnrollmentTokensPanel />
  </section>
</template>
