<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Activity, AlertTriangle, Box, RefreshCw } from "lucide-vue-next";
import { api, type Incident } from "../../lib/api.js";
import Card from "../../components/Card.vue";
import Badge from "../../components/Badge.vue";
import Button from "../../components/Button.vue";

const POLL_INTERVAL = 15_000;

const STATUS_BADGE_VARIANT: Record<string, "danger" | "warning" | "success" | "muted"> = {
  open: "danger",
  acknowledged: "warning",
  resolved: "success",
  closed: "muted"
};

function previewText(inc: Incident): string {
  const raw = inc.message ?? inc.fingerprint.slice(0, 24);
  return raw.length > 96 ? `${raw.slice(0, 96)}…` : raw;
}

const loading = ref(true);
const error = ref<string | null>(null);
const agentCount = ref(0);
const openIncidentsCount = ref(0);
const serviceCount = ref(0);
const recentIncidents = ref<Incident[]>([]);
const lastUpdated = ref<Date | null>(null);
const secondsAgo = ref(0);

async function fetchData() {
  error.value = null;
  try {
    const [incRes, agRes, svcRes] = await Promise.all([api.listIncidents(), api.listAgents(), api.listServices()]);
    agentCount.value = agRes.agents.length;
    openIncidentsCount.value = incRes.incidents.filter((i) => i.status === "open").length;
    serviceCount.value = svcRes.services.length;
    recentIncidents.value = [...incRes.incidents]
      .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
      .slice(0, 5);
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
  pollId = setInterval(() => void fetchData(), POLL_INTERVAL);
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

const statValue = computed(() => (n: number) => {
  if (loading.value) return "...";
  if (error.value) return "—";
  return String(n);
});
</script>

<template>
  <section>
    <div :style="{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }">
      <h2 :style="{ margin: 0 }">Dashboard</h2>
      <div :style="{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.75rem' }">
        <span v-if="lastUpdated" :style="{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">
          Last updated: {{ secondsAgo }}s ago
        </span>
        <Button size="sm" variant="ghost" @click="fetchData">
          <RefreshCw :size="14" /> Refresh
        </Button>
      </div>
    </div>

    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.75rem' }" role="alert">
      {{ error }}
    </div>

    <div :style="{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }">
      <Card>
        <div :style="{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: 'var(--color-text-secondary)' }">
          <Activity :size="16" /> Connected Agents
        </div>
        <div :style="{ marginTop: '0.5rem', fontSize: '1.5rem', fontWeight: 700 }">{{ statValue(agentCount) }}</div>
      </Card>
      <Card>
        <div :style="{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: 'var(--color-text-secondary)' }">
          <AlertTriangle :size="16" /> Open Incidents
        </div>
        <div :style="{ marginTop: '0.5rem', fontSize: '1.5rem', fontWeight: 700 }">{{ statValue(openIncidentsCount) }}</div>
      </Card>
      <Card>
        <div :style="{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: 'var(--color-text-secondary)' }">
          <Box :size="16" /> Monitored Services
        </div>
        <div :style="{ marginTop: '0.5rem', fontSize: '1.5rem', fontWeight: 700 }">{{ statValue(serviceCount) }}</div>
      </Card>
    </div>

    <h3 :style="{ margin: '0 0 0.65rem', fontSize: '1rem', fontWeight: 600 }">Recent Incidents</h3>
    <p v-if="loading" :style="{ color: 'var(--color-text-secondary)', margin: 0 }">Loading…</p>
    <p
      v-else-if="!error && recentIncidents.length === 0"
      :style="{ color: 'var(--color-text-secondary)', margin: 0 }"
    >
      No incidents yet.
    </p>
    <ul v-else-if="!error" :style="{ listStyle: 'none', padding: 0, margin: 0 }">
      <li
        v-for="inc in recentIncidents"
        :key="inc.id"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.65rem 0',
          borderBottom: '1px solid var(--color-border)',
          fontSize: '0.9rem'
        }"
      >
        <Badge :variant="STATUS_BADGE_VARIANT[inc.status] ?? 'muted'">{{ inc.status }}</Badge>
        <span
          :style="{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }"
          :title="inc.message ?? inc.fingerprint"
        >
          {{ previewText(inc) }}
        </span>
        <time
          :datetime="inc.lastSeenAt"
          :style="{ flexShrink: 0, color: 'var(--color-text-secondary)', fontSize: '0.85rem' }"
        >
          {{ new Date(inc.lastSeenAt).toLocaleString() }}
        </time>
      </li>
    </ul>

    <Card title="Recent Remediation Plans" :style="{ marginTop: '1.5rem' }">
      <p :style="{ color: 'var(--color-text-secondary)', margin: 0, fontSize: '0.9rem' }">
        Remediation plans are queued automatically when incidents are detected. View plan status in the Incidents
        detail view.
      </p>
    </Card>

    <p :style="{ color: 'var(--color-text-secondary)', marginTop: '1.25rem' }">
      Navigate using the sidebar to manage agents, services, and incidents.
    </p>
  </section>
</template>
