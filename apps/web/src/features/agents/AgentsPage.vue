<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, type CSSProperties } from "vue";
import { Check, ChevronDown, ChevronRight, Cpu, Pencil, RefreshCw, Trash2, X } from "lucide-vue-next";
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
import { useTelemetryStream } from "./useTelemetryStream.js";
import ErrorGroupsSection from "./ErrorGroupsSection.vue";
import EnrollmentTokensPanel from "./EnrollmentTokensPanel.vue";
import ServicesForAgentSection from "./ServicesForAgentSection.vue";

const POLL_INTERVAL_MS = 30_000;

const AGENT_STATUS_BADGE: Record<string, "success" | "warning" | "danger" | "muted"> = {
  online: "success",
  degraded: "warning",
  offline: "danger",
  unknown: "muted"
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.8rem",
  fontWeight: 600
};
const tdStyle: CSSProperties = { padding: "0.5rem", verticalAlign: "top" };

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
function truncateFingerprint(fp: string | null | undefined, max = 18): string {
  if (fp == null || fp === "") return "—";
  if (fp.length <= max) return fp;
  return `${fp.slice(0, max)}…`;
}
function formatBytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const precision = v >= 100 || i === 0 ? 0 : 1;
  return `${v.toFixed(precision)} ${units[i]}`;
}
function formatBytesPerSec(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${formatBytes(n)}/s`;
}
function formatPercent(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

function buildServiceCounts(services: MonitoredService[]): Map<string, { count: number; names: string[] }> {
  const m = new Map<string, { count: number; names: string[] }>();
  for (const s of services) {
    for (const binding of s.agents ?? []) {
      const cur = m.get(binding.agentId) ?? { count: 0, names: [] };
      cur.count += 1;
      cur.names.push(s.name);
      m.set(binding.agentId, cur);
    }
  }
  return m;
}

const auth = useAuth();
const isViewer = computed(() => auth.value.isViewer);

const agents = ref<Agent[]>([]);
const services = ref<MonitoredService[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const lastUpdated = ref<Date | null>(null);
const secondsAgo = ref(0);
const editingId = ref<string | null>(null);
const editName = ref("");
const savingId = ref<string | null>(null);
const expanded = reactive<Record<string, boolean>>({});

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

const serviceInfoByAgent = computed(() => buildServiceCounts(services.value));

const displayedAgents = computed<Agent[]>(() =>
  agents.value.map((a) => {
    const liveHost: AgentTelemetry | undefined = live.host[a.id];
    const liveApps = live.apps[a.id];
    const livePresence = live.presence[a.id];
    const apps: AgentAppTelemetry[] = liveApps ? Object.values(liveApps) : a.apps ?? [];
    const telemetry: AgentTelemetry | undefined = liveHost ?? a.telemetry;
    return {
      ...a,
      ...(telemetry ? { telemetry } : {}),
      ...(apps.length > 0 ? { apps } : {}),
      websocketConnected: livePresence !== undefined ? livePresence : a.websocketConnected
    };
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

function startEdit(a: Agent) {
  editingId.value = a.id;
  editName.value = a.name ?? "";
  actionError.value = null;
}
function cancelEdit() {
  editingId.value = null;
  editName.value = "";
}
async function saveEdit(agentId: string) {
  const trimmed = editName.value.trim();
  savingId.value = agentId;
  actionError.value = null;
  try {
    await api.updateAgent(agentId, { name: trimmed === "" ? null : trimmed });
    editingId.value = null;
    editName.value = "";
    await fetchData();
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
  } finally {
    savingId.value = null;
  }
}
async function deleteAgent(agentId: string, displayName: string) {
  if (!window.confirm(`Remove agent "${displayName}"? Any services bound to it will be detached.`)) return;
  savingId.value = agentId;
  actionError.value = null;
  try {
    await api.deleteAgent(agentId);
    await fetchData();
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
  } finally {
    savingId.value = null;
  }
}

function toggleExpanded(id: string) {
  expanded[id] = !expanded[id];
}
function appsList(a: Agent): AgentAppTelemetry[] {
  return a.apps ?? [];
}
function badgeVariant(status: string): "success" | "warning" | "danger" | "muted" {
  return AGENT_STATUS_BADGE[status] ?? "muted";
}
function diskPct(t: AgentTelemetry | undefined): string {
  if (!t || t.diskUsedBytes === undefined || t.diskTotalBytes === undefined) return "—";
  return formatPercent((t.diskUsedBytes / t.diskTotalBytes) * 100);
}
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
    <div v-if="actionError" :style="{ color: 'var(--color-danger)', marginBottom: '0.75rem' }" role="alert">
      {{ actionError }}
    </div>

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
      <table :style="{ width: '100%', borderCollapse: 'collapse', minWidth: '1200px' }">
        <thead>
          <tr>
            <th scope="col" :style="thStyle">Agent</th>
            <th scope="col" :style="thStyle">Live</th>
            <th scope="col" :style="thStyle">Status</th>
            <th scope="col" :style="thStyle">Version</th>
            <th scope="col" :style="thStyle">Last seen</th>
            <th scope="col" :style="thStyle">CPU</th>
            <th scope="col" :style="thStyle">Memory</th>
            <th scope="col" :style="thStyle">Disk</th>
            <th scope="col" :style="thStyle">Net RX</th>
            <th scope="col" :style="thStyle">Net TX</th>
            <th scope="col" :style="thStyle">Process RSS</th>
            <th scope="col" :style="thStyle">Capabilities</th>
            <th scope="col" :style="thStyle">Certificate</th>
            <th scope="col" :style="thStyle">Services</th>
            <th v-if="!isViewer" scope="col" :style="thStyle">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="a in displayedAgents" :key="a.id">
            <tr>
              <td :style="tdStyle">
                <span :style="{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }">
                  <button
                    type="button"
                    :aria-label="expanded[a.id] ? 'Collapse apps' : 'Expand apps'"
                    :aria-expanded="expanded[a.id] === true"
                    :style="{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      color: 'var(--color-text-secondary)',
                      display: 'inline-flex'
                    }"
                    @click="toggleExpanded(a.id)"
                  >
                    <ChevronDown v-if="expanded[a.id]" :size="14" />
                    <ChevronRight v-else :size="14" />
                  </button>
                  <Cpu :size="14" aria-hidden />
                  <input
                    v-if="editingId === a.id"
                    v-model="editName"
                    :aria-label="`Rename agent ${a.id}`"
                    :disabled="savingId === a.id"
                    :style="{
                      padding: '0.25rem 0.4rem',
                      fontSize: '0.85rem',
                      background: 'var(--color-surface)',
                      color: 'var(--color-text-primary)',
                      border: '1px solid var(--color-border)',
                      borderRadius: '4px',
                      minWidth: '180px'
                    }"
                  />
                  <span v-else>
                    <span :style="{ fontWeight: 600 }">{{ a.name?.trim() || a.id }}</span>
                    <div
                      v-if="a.name?.trim()"
                      :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }"
                    >{{ a.id }}</div>
                    <div
                      v-if="appsList(a).length > 0"
                      :style="{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }"
                    >
                      {{ appsList(a).length }} app{{ appsList(a).length === 1 ? "" : "s" }}
                    </div>
                  </span>
                </span>
              </td>
              <td :style="tdStyle">
                <Badge :variant="a.websocketConnected ? 'success' : 'muted'">
                  {{ a.websocketConnected ? "Yes" : "No" }}
                </Badge>
              </td>
              <td :style="tdStyle">
                <Badge :variant="badgeVariant(a.status)">{{ a.status }}</Badge>
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.85rem' }">{{ a.version ?? "—" }}</td>
              <td :style="tdStyle">
                <span :title="a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString() : undefined">
                  {{ formatRelativeTime(a.lastSeenAt) }}
                </span>
                <div
                  v-if="a.lastSeenAt"
                  :style="{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }"
                >{{ new Date(a.lastSeenAt).toLocaleString() }}</div>
              </td>
              <td
                :style="{ ...tdStyle, fontSize: '0.85rem' }"
                :title="a.telemetry ? `Sampled ${new Date(a.telemetry.ts).toLocaleString()}` : undefined"
              >{{ formatPercent(a.telemetry?.cpuPercent) }}</td>
              <td :style="{ ...tdStyle, fontSize: '0.85rem' }">
                <template v-if="a.telemetry?.memPercent !== undefined">
                  <div>{{ formatPercent(a.telemetry.memPercent) }}</div>
                  <div
                    v-if="a.telemetry.memUsedBytes !== undefined && a.telemetry.memTotalBytes !== undefined"
                    :style="{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }"
                  >
                    {{ formatBytes(a.telemetry.memUsedBytes) }} / {{ formatBytes(a.telemetry.memTotalBytes) }}
                  </div>
                </template>
                <template v-else>—</template>
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.85rem' }" :title="a.telemetry?.diskPath">
                <template v-if="a.telemetry?.diskUsedBytes !== undefined && a.telemetry?.diskTotalBytes !== undefined">
                  <div>{{ diskPct(a.telemetry) }}</div>
                  <div :style="{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }">
                    {{ formatBytes(a.telemetry.diskUsedBytes) }} / {{ formatBytes(a.telemetry.diskTotalBytes) }}
                  </div>
                </template>
                <template v-else>—</template>
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.85rem' }">
                {{ formatBytesPerSec(a.telemetry?.netRxBytesPerSec) }}
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.85rem' }">
                {{ formatBytesPerSec(a.telemetry?.netTxBytesPerSec) }}
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.85rem' }">{{ formatBytes(a.telemetry?.processRSSBytes) }}</td>
              <td :style="{ ...tdStyle, fontSize: '0.8rem', maxWidth: '200px' }">
                <span
                  v-if="a.allowedCapabilities && a.allowedCapabilities.length > 0"
                  :title="a.allowedCapabilities.join(', ')"
                >{{ a.allowedCapabilities.join(", ") }}</span>
                <template v-else>—</template>
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.78rem', fontFamily: 'ui-monospace, monospace' }">
                <span :title="a.certFingerprint ?? undefined">
                  {{ truncateFingerprint(a.certFingerprint ?? null) }}
                </span>
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.85rem' }">
                <a
                  v-if="(serviceInfoByAgent.get(a.id)?.count ?? 0) > 0"
                  href="#services"
                  :style="{ color: 'var(--color-primary)' }"
                  :title="serviceInfoByAgent.get(a.id)?.names.join(', ')"
                >{{ serviceInfoByAgent.get(a.id)?.count }}</a>
                <template v-else>0</template>
              </td>
              <td v-if="!isViewer" :style="{ ...tdStyle, fontSize: '0.85rem' }">
                <span v-if="editingId === a.id" :style="{ display: 'inline-flex', gap: '0.35rem' }">
                  <Button
                    size="sm"
                    variant="primary"
                    :disabled="savingId === a.id"
                    :aria-label="`Save name for agent ${a.id}`"
                    @click="saveEdit(a.id)"
                  ><Check :size="14" /> Save</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    :disabled="savingId === a.id"
                    :aria-label="`Cancel rename for agent ${a.id}`"
                    @click="cancelEdit"
                  ><X :size="14" /> Cancel</Button>
                </span>
                <span v-else :style="{ display: 'inline-flex', gap: '0.35rem' }">
                  <Button
                    size="sm"
                    variant="ghost"
                    :disabled="savingId === a.id"
                    :aria-label="`Rename agent ${a.id}`"
                    @click="startEdit(a)"
                  ><Pencil :size="14" /> Rename</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    :disabled="savingId === a.id"
                    :aria-label="`Remove agent ${a.id}`"
                    @click="deleteAgent(a.id, a.name?.trim() || a.id)"
                  ><Trash2 :size="14" /> Remove</Button>
                </span>
              </td>
            </tr>
            <tr v-if="expanded[a.id]">
              <td
                :colspan="14"
                :style="{
                  ...tdStyle,
                  padding: '0.25rem 0.5rem 1rem 2rem',
                  background: 'var(--color-surface-muted, transparent)'
                }"
              >
                <div v-if="appsList(a).length === 0">
                  <p :style="{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">
                    No managed apps yet. Telemetry is only reported for apps the agent manages (Docker containers from
                    sync_desired_state). Attach services to this agent or push a desired-state update to populate this
                    table.
                  </p>
                </div>
                <div v-else :style="{ overflowX: 'auto' }">
                  <table :style="{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: '800px' }">
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
                      <tr v-for="app in [...appsList(a)].sort((x, y) => (x.name ?? x.containerId).localeCompare(y.name ?? y.containerId))" :key="app.containerId">
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
                        <td :style="{ ...tdStyle, fontSize: '0.75rem' }" :title="app.image">
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

                <ServicesForAgentSection
                  :agent-id="a.id"
                  :all-services="services"
                  :disabled="isViewer"
                  @change="fetchData"
                />

                <div :style="{ marginTop: '1rem' }">
                  <h3
                    :style="{ margin: '0 0 0.5rem', fontSize: '0.9rem', color: 'var(--color-text-secondary)' }"
                  >Error groups (auto-fix)</h3>
                  <ErrorGroupsSection :agent-id="a.id" :live-groups="live.errorGroups" />
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
