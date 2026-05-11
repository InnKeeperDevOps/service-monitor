<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type CSSProperties } from "vue";
import {
  ArrowLeft,
  Check,
  Cpu,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from "lucide-vue-next";
import {
  api,
  type Agent,
  type AgentAppTelemetry,
  type AgentTelemetry,
  type MonitoredService
} from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import Badge from "../../components/Badge.vue";
import Button from "../../components/Button.vue";
import Card from "../../components/Card.vue";
import { useTelemetryStream } from "./useTelemetryStream.js";
import ServicesForAgentSection from "./ServicesForAgentSection.vue";
import ErrorGroupsSection from "./ErrorGroupsSection.vue";
import {
  AGENT_STATUS_BADGE,
  badgeVariantForStatus,
  formatBytes,
  formatBytesPerSec,
  formatPercent,
  formatRelativeTime,
  formatRuntimeBackend,
  truncateFingerprint
} from "./format.js";
import {
  appendTelemetrySample,
  clearCachedAgentDetail,
  readCachedAgentDetail,
  writeCachedAgentDetail,
  type TelemetrySample
} from "./cache.js";
import TelemetrySpark from "./TelemetrySpark.vue";

const props = defineProps<{ agentId: string }>();

const auth = useAuth();
const isViewer = computed(() => auth.value.isViewer);

const POLL_INTERVAL_MS = 30_000;

const agent = ref<Agent | null>(null);
const services = ref<MonitoredService[]>([]);
// Telemetry snapshot pulled from cache — used until the live WS stream
// produces a fresh frame. After that, `live.host[id]` takes over (see
// `merged` below).
const cachedHostTelemetry = ref<AgentTelemetry | null>(null);
// Ring buffer of recent samples for the sparklines. Hydrated from
// cache on mount; appended to on every fresh host_stats frame.
const samples = ref<TelemetrySample[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const editing = ref(false);
const editName = ref("");
const saving = ref(false);

const live = useTelemetryStream(() => true);

// Pre-fill from cache so the page renders immediately on navigation.
// fetchData() will overwrite below once the network responds.
function hydrateFromCache(id: string) {
  const cached = readCachedAgentDetail(id);
  if (!cached) return;
  if (cached.agent) agent.value = cached.agent;
  if (cached.services.length > 0) services.value = cached.services;
  if (cached.hostTelemetry) cachedHostTelemetry.value = cached.hostTelemetry;
  if (cached.telemetrySamples?.length) samples.value = cached.telemetrySamples;
}

async function fetchData() {
  error.value = null;
  try {
    const [a, sr] = await Promise.all([
      api.getAgent(props.agentId).catch(() => null),
      api.listServices()
    ]);
    agent.value = a;
    services.value = sr.services;
    writeCachedAgentDetail(props.agentId, { agent: a, services: sr.services });
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

let pollId: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  hydrateFromCache(props.agentId);
  // If hydrate gave us an agent, drop the loading skeleton even
  // though the network call is still in flight.
  if (agent.value) loading.value = false;
  void fetchData();
  pollId = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
});
onUnmounted(() => {
  if (pollId) clearInterval(pollId);
});
watch(
  () => props.agentId,
  (newId) => {
    agent.value = null;
    services.value = [];
    cachedHostTelemetry.value = null;
    loading.value = true;
    hydrateFromCache(newId);
    if (agent.value) loading.value = false;
    void fetchData();
  }
);

// Persist every fresh host_stats frame so the next navigation can
// render telemetry instantly. live.host[id] is reactive — watch it,
// write the latest snapshot AND append to the sparkline ring.
watch(
  () => live.host[props.agentId],
  (t) => {
    if (!t) return;
    const now = Date.now();
    writeCachedAgentDetail(props.agentId, { hostTelemetry: t, hostTelemetrySampledAt: now });
    const diskPercent =
      t.diskUsedBytes !== undefined && t.diskTotalBytes !== undefined && t.diskTotalBytes > 0
        ? (t.diskUsedBytes / t.diskTotalBytes) * 100
        : undefined;
    samples.value = appendTelemetrySample(props.agentId, {
      ts: now,
      cpuPercent: t.cpuPercent,
      memPercent: t.memPercent,
      diskPercent,
      netRxBytesPerSec: t.netRxBytesPerSec,
      netTxBytesPerSec: t.netTxBytesPerSec,
      processRSSBytes: t.processRSSBytes
    });
  },
  { deep: true }
);

// Merge stored agent fields with live telemetry (same pattern as the
// list page) so values update in real time without a refetch.
const merged = computed<Agent | null>(() => {
  if (!agent.value) return null;
  const a = agent.value;
  const liveHost: AgentTelemetry | undefined = live.host[a.id];
  const liveApps = live.apps[a.id];
  const livePresence = live.presence[a.id];
  const apps: AgentAppTelemetry[] = liveApps ? Object.values(liveApps) : a.apps ?? [];
  // Telemetry resolution order: live WS frame → server-side stored
  // sample → cached frame from a previous session. Cache fills the
  // gap between page load and the first live frame after navigation.
  const telemetry: AgentTelemetry | undefined =
    liveHost ?? a.telemetry ?? cachedHostTelemetry.value ?? undefined;
  return {
    ...a,
    ...(telemetry ? { telemetry } : {}),
    ...(apps.length > 0 ? { apps } : {}),
    websocketConnected: livePresence !== undefined ? livePresence : a.websocketConnected
  };
});

const apps = computed<AgentAppTelemetry[]>(() => merged.value?.apps ?? []);

function startEdit() {
  if (!merged.value) return;
  editing.value = true;
  editName.value = merged.value.name ?? "";
  actionError.value = null;
}
function cancelEdit() {
  editing.value = false;
  editName.value = "";
}
async function saveEdit() {
  const trimmed = editName.value.trim();
  saving.value = true;
  actionError.value = null;
  try {
    await api.updateAgent(props.agentId, { name: trimmed === "" ? null : trimmed });
    editing.value = false;
    editName.value = "";
    await fetchData();
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
async function onEnvironmentChange(value: string) {
  saving.value = true;
  actionError.value = null;
  try {
    await api.updateAgent(props.agentId, { environment: value });
    await fetchData();
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
async function deleteAgent() {
  if (!merged.value) return;
  const displayName = merged.value.name?.trim() || merged.value.id;
  if (!window.confirm(`Remove agent "${displayName}"? Any services bound to it will be detached.`)) return;
  saving.value = true;
  actionError.value = null;
  try {
    await api.deleteAgent(props.agentId);
    clearCachedAgentDetail(props.agentId);
    window.location.hash = "agents";
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
    saving.value = false;
  }
}

function diskPct(t: AgentTelemetry | undefined): string {
  if (!t || t.diskUsedBytes === undefined || t.diskTotalBytes === undefined) return "—";
  return formatPercent((t.diskUsedBytes / t.diskTotalBytes) * 100);
}

const cellTitle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: "0.2rem"
};
const cellValue: CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 600
};

const tdStyle: CSSProperties = { padding: "0.5rem", verticalAlign: "top" };
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.8rem",
  fontWeight: 600
};
</script>

<template>
  <section :style="{ maxWidth: '1100px' }">
    <a
      href="#agents"
      :style="{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        color: 'var(--color-text-secondary)',
        textDecoration: 'none',
        fontSize: '0.85rem',
        marginBottom: '0.75rem'
      }"
    >
      <ArrowLeft :size="14" /> Back to Agents
    </a>

    <p v-if="loading" :style="{ color: 'var(--color-text-secondary)' }">Loading…</p>

    <Card v-if="error" :style="{ borderColor: 'var(--color-danger)', marginBottom: '1rem' }">
      <p :style="{ color: 'var(--color-danger)', margin: 0 }">{{ error }}</p>
    </Card>

    <Card v-if="!loading && !merged">
      <p :style="{ color: 'var(--color-text-secondary)', margin: 0 }">
        Agent <code>{{ agentId }}</code> wasn't found in this tenant.
      </p>
    </Card>

    <template v-if="merged">
      <header
        :style="{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
          marginBottom: '1rem',
          flexWrap: 'wrap'
        }"
      >
        <Cpu :size="22" :style="{ marginTop: '0.4rem' }" />
        <div :style="{ flex: 1, minWidth: '300px' }">
          <div :style="{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }">
            <input
              v-if="editing"
              v-model="editName"
              :aria-label="`Rename agent ${merged.id}`"
              :disabled="saving"
              :style="{
                padding: '0.3rem 0.5rem',
                fontSize: '1.1rem',
                fontWeight: 600,
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: '4px',
                minWidth: '240px'
              }"
            />
            <h2 v-else :style="{ margin: 0 }">{{ merged.name?.trim() || merged.id }}</h2>
            <Badge :variant="merged.websocketConnected ? 'success' : 'muted'">
              {{ merged.websocketConnected ? "live" : "offline" }}
            </Badge>
            <Badge :variant="badgeVariantForStatus(merged.status)">{{ merged.status }}</Badge>
            <Badge variant="muted">runtime: {{ formatRuntimeBackend(merged.runtimeBackend) }}</Badge>
            <Badge variant="muted">{{ merged.environment }}</Badge>
          </div>
          <div
            :style="{
              fontSize: '0.78rem',
              fontFamily: 'ui-monospace, monospace',
              color: 'var(--color-text-secondary)',
              marginTop: '0.2rem'
            }"
          >{{ merged.id }}</div>
        </div>
        <div v-if="!isViewer" :style="{ display: 'flex', gap: '0.4rem' }">
          <Button v-if="!editing" size="sm" variant="ghost" :disabled="saving" @click="startEdit">
            <Pencil :size="14" /> Rename
          </Button>
          <template v-else>
            <Button size="sm" variant="primary" :disabled="saving" @click="saveEdit">
              <Check :size="14" /> Save
            </Button>
            <Button size="sm" variant="ghost" :disabled="saving" @click="cancelEdit">
              <X :size="14" /> Cancel
            </Button>
          </template>
          <Button size="sm" variant="ghost" :disabled="saving" @click="fetchData">
            <RefreshCw :size="14" /> Refresh
          </Button>
          <Button size="sm" variant="ghost" :disabled="saving" @click="deleteAgent">
            <Trash2 :size="14" /> Remove
          </Button>
        </div>
      </header>

      <p
        v-if="actionError"
        :style="{ color: 'var(--color-danger)', marginBottom: '0.75rem', fontSize: '0.85rem' }"
        role="alert"
      >{{ actionError }}</p>

      <!-- Identity / config card -->
      <Card title="Identity" :style="{ marginBottom: '1rem' }">
        <div
          :style="{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '1rem',
            fontSize: '0.85rem'
          }"
        >
          <div>
            <div :style="cellTitle">Environment</div>
            <select
              v-if="!isViewer"
              :value="merged.environment"
              :disabled="saving"
              :style="{
                padding: '0.25rem 0.45rem',
                fontSize: '0.9rem',
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: '4px'
              }"
              @change="onEnvironmentChange(($event.target as HTMLSelectElement).value)"
            >
              <option value="development">development</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
              <option
                v-if="!['development','staging','production'].includes(merged.environment)"
                :value="merged.environment"
              >{{ merged.environment }}</option>
            </select>
            <span v-else :style="cellValue">{{ merged.environment }}</span>
          </div>
          <div>
            <div :style="cellTitle">Runtime</div>
            <div :style="cellValue">{{ formatRuntimeBackend(merged.runtimeBackend) }}</div>
          </div>
          <div>
            <div :style="cellTitle">Version</div>
            <div :style="cellValue">{{ merged.version ?? "—" }}</div>
          </div>
          <div>
            <div :style="cellTitle">Last seen</div>
            <div :style="cellValue" :title="merged.lastSeenAt ?? undefined">
              {{ formatRelativeTime(merged.lastSeenAt) }}
            </div>
          </div>
          <div>
            <div :style="cellTitle">Cert fingerprint</div>
            <div
              :style="{ ...cellValue, fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' }"
              :title="merged.certFingerprint ?? undefined"
            >{{ truncateFingerprint(merged.certFingerprint ?? null, 28) }}</div>
          </div>
          <div :style="{ gridColumn: '1 / -1' }">
            <div :style="cellTitle">Capabilities</div>
            <div
              v-if="merged.allowedCapabilities && merged.allowedCapabilities.length > 0"
              :style="{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }"
            >
              <Badge v-for="c in merged.allowedCapabilities" :key="c" variant="muted">{{ c }}</Badge>
            </div>
            <div v-else :style="{ color: 'var(--color-text-secondary)' }">none granted</div>
          </div>
        </div>
      </Card>

      <!-- Host telemetry card -->
      <Card title="Host telemetry" :style="{ marginBottom: '1rem' }">
        <div
          :style="{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '1rem'
          }"
        >
          <div>
            <div :style="cellTitle">CPU</div>
            <div :style="cellValue">{{ formatPercent(merged.telemetry?.cpuPercent) }}</div>
            <TelemetrySpark
              :samples="samples"
              :pick="(s) => s.cpuPercent"
              domain="percent"
              color="#4f8cff"
            />
          </div>
          <div>
            <div :style="cellTitle">Memory</div>
            <div :style="cellValue">{{ formatPercent(merged.telemetry?.memPercent) }}</div>
            <div
              v-if="merged.telemetry?.memUsedBytes !== undefined && merged.telemetry?.memTotalBytes !== undefined"
              :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }"
            >
              {{ formatBytes(merged.telemetry.memUsedBytes) }} / {{ formatBytes(merged.telemetry.memTotalBytes) }}
            </div>
            <TelemetrySpark
              :samples="samples"
              :pick="(s) => s.memPercent"
              domain="percent"
              color="#9d6cff"
            />
          </div>
          <div :title="merged.telemetry?.diskPath">
            <div :style="cellTitle">Disk</div>
            <div :style="cellValue">{{ diskPct(merged.telemetry) }}</div>
            <div
              v-if="merged.telemetry?.diskUsedBytes !== undefined && merged.telemetry?.diskTotalBytes !== undefined"
              :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }"
            >
              {{ formatBytes(merged.telemetry.diskUsedBytes) }} / {{ formatBytes(merged.telemetry.diskTotalBytes) }}
            </div>
            <TelemetrySpark
              :samples="samples"
              :pick="(s) => s.diskPercent"
              domain="percent"
              color="#22a06b"
            />
          </div>
          <div>
            <div :style="cellTitle">Net RX</div>
            <div :style="cellValue">{{ formatBytesPerSec(merged.telemetry?.netRxBytesPerSec) }}</div>
            <TelemetrySpark
              :samples="samples"
              :pick="(s) => s.netRxBytesPerSec"
              domain="auto"
              color="#0aa5b5"
            />
          </div>
          <div>
            <div :style="cellTitle">Net TX</div>
            <div :style="cellValue">{{ formatBytesPerSec(merged.telemetry?.netTxBytesPerSec) }}</div>
            <TelemetrySpark
              :samples="samples"
              :pick="(s) => s.netTxBytesPerSec"
              domain="auto"
              color="#e08a3c"
            />
          </div>
          <div>
            <div :style="cellTitle">Process RSS</div>
            <div :style="cellValue">{{ formatBytes(merged.telemetry?.processRSSBytes) }}</div>
            <TelemetrySpark
              :samples="samples"
              :pick="(s) => s.processRSSBytes"
              domain="auto"
              color="#a36ad9"
            />
          </div>
        </div>
        <div
          :style="{
            marginTop: '0.6rem',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.75rem',
            color: 'var(--color-text-secondary)'
          }"
        >
          <span v-if="merged.telemetry?.ts">
            Sampled {{ new Date(merged.telemetry.ts).toLocaleString() }}
          </span>
          <span v-else />
          <span v-if="samples.length > 0">{{ samples.length }} sample{{ samples.length === 1 ? "" : "s" }} buffered</span>
        </div>
      </Card>

      <!-- Bound services + running version -->
      <Card title="Services" :style="{ marginBottom: '1rem' }">
        <ServicesForAgentSection
          :agent-id="merged.id"
          :all-services="services"
          :disabled="isViewer"
          @change="fetchData"
        />
      </Card>

      <!-- Apps (per-container telemetry) -->
      <Card title="Apps" :style="{ marginBottom: '1rem' }">
        <p
          v-if="apps.length === 0"
          :style="{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-secondary)' }"
        >
          No managed apps yet. Telemetry is only reported for apps the agent manages
          (Docker containers from sync_desired_state). Attach services to this agent or
          push a desired-state update to populate this table.
        </p>
        <div v-else :style="{ overflowX: 'auto' }">
          <table :style="{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: '720px' }">
            <thead>
              <tr>
                <th :style="thStyle">Container</th>
                <th :style="thStyle">Image</th>
                <th :style="thStyle">State</th>
                <th :style="thStyle">CPU</th>
                <th :style="thStyle">Memory</th>
                <th :style="thStyle">Net RX</th>
                <th :style="thStyle">Net TX</th>
                <th :style="thStyle">Sampled</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="app in [...apps].sort((x, y) => (x.name ?? x.containerId).localeCompare(y.name ?? y.containerId))"
                :key="app.containerId"
                :style="{ borderTop: '1px solid var(--color-border)' }"
              >
                <td :style="tdStyle">
                  <div :style="{ fontWeight: 600 }">{{ app.name ?? app.containerId.slice(0, 12) }}</div>
                  <div
                    :style="{
                      fontSize: '0.7rem',
                      color: 'var(--color-text-secondary)',
                      fontFamily: 'ui-monospace, monospace'
                    }"
                  >{{ app.containerId.slice(0, 12) }}</div>
                </td>
                <td :style="{ ...tdStyle, fontSize: '0.78rem' }" :title="app.image">
                  {{ app.image ? app.image.split("@")[0] : "—" }}
                </td>
                <td :style="tdStyle">
                  <Badge :variant="app.state === 'running' ? 'success' : 'muted'">
                    {{ app.state ?? "—" }}
                  </Badge>
                </td>
                <td :style="tdStyle">{{ formatPercent(app.cpuPercent) }}</td>
                <td :style="tdStyle">
                  <template v-if="app.memPercent !== undefined">
                    <div>{{ formatPercent(app.memPercent) }}</div>
                    <div
                      v-if="app.memUsedBytes !== undefined && app.memLimitBytes !== undefined"
                      :style="{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }"
                    >
                      {{ formatBytes(app.memUsedBytes) }} / {{ formatBytes(app.memLimitBytes) }}
                    </div>
                  </template>
                  <template v-else-if="app.memUsedBytes !== undefined">
                    {{ formatBytes(app.memUsedBytes) }}
                  </template>
                  <template v-else>—</template>
                </td>
                <td :style="tdStyle">{{ formatBytesPerSec(app.netRxBytesPerSec) }}</td>
                <td :style="tdStyle">{{ formatBytesPerSec(app.netTxBytesPerSec) }}</td>
                <td :style="{ ...tdStyle, fontSize: '0.7rem', color: 'var(--color-text-secondary)' }">
                  {{ new Date(app.ts).toLocaleTimeString() }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Error groups (auto-fix)">
        <ErrorGroupsSection :agent-id="merged.id" :live-groups="live.errorGroups" />
      </Card>
    </template>
  </section>
</template>
