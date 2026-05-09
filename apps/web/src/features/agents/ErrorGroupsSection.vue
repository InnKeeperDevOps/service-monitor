<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from "vue";
import { AlertTriangle, KeyRound, Loader2, Pause, ShieldCheck } from "lucide-vue-next";
import { api, type ErrorGroup, type ErrorGroupStatus } from "../../lib/api.js";
import Badge from "../../components/Badge.vue";

const props = defineProps<{
  agentId: string;
  liveGroups: Record<string, ErrorGroup>;
}>();

const STATUS_BADGE: Record<ErrorGroupStatus, "success" | "warning" | "danger" | "muted" | "info"> = {
  open: "warning",
  fixing: "info",
  fixed: "success",
  paused: "danger",
  missing_auth: "danger"
};
const STATUS_ICON: Record<ErrorGroupStatus, Component> = {
  open: AlertTriangle,
  fixing: Loader2,
  fixed: ShieldCheck,
  paused: Pause,
  missing_auth: KeyRound
};
const STATUS_HINT: Record<ErrorGroupStatus, string> = {
  open: "Detected. Awaiting auto-fix dispatch.",
  fixing: "A claude session is rewriting the repo and will push to main.",
  fixed: "Fix pushed. Watching for re-occurrence within 30 minutes.",
  paused: "Same error reappeared shortly after a fix — auto-fix paused. Investigate manually.",
  missing_auth: "Service has no SSH key. Add one in Services to enable auto-fix."
};

function formatRelativeTime(iso: string | null | undefined): string {
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

const snapshot = ref<ErrorGroup[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(agentId: string) {
  loading.value = true;
  try {
    const r = await api.listErrorGroupsForAgent(agentId);
    snapshot.value = r.groups;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load(props.agentId));
watch(
  () => props.agentId,
  (id) => void load(id)
);

const merged = computed(() => {
  const byId = new Map<string, ErrorGroup>();
  for (const g of snapshot.value) byId.set(g.id, g);
  for (const g of Object.values(props.liveGroups)) {
    if (g.agentId === props.agentId) byId.set(g.id, g);
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  );
});

const thStyle = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.78rem",
  fontWeight: 600
} as const;
const tdStyle = { padding: "0.5rem", verticalAlign: "top", fontSize: "0.85rem" } as const;
</script>

<template>
  <p v-if="loading" :style="{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">
    Loading error groups…
  </p>
  <p v-else-if="error" :style="{ margin: 0, color: 'var(--color-danger)', fontSize: '0.8rem' }">{{ error }}</p>
  <p v-else-if="merged.length === 0" :style="{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">
    No error groups for this agent. Auto-fix triggers when a managed app emits an error log and the service has an SSH
    key configured for git push.
  </p>
  <div v-else :style="{ overflowX: 'auto' }">
    <table :style="{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: '800px' }">
      <thead>
        <tr>
          <th :style="thStyle">Status</th>
          <th :style="thStyle">Service</th>
          <th :style="thStyle">Error</th>
          <th :style="thStyle">Count</th>
          <th :style="thStyle">Last seen</th>
          <th :style="thStyle">Last fix</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in merged" :key="g.id">
          <td :style="tdStyle">
            <span
              :title="STATUS_HINT[g.status]"
              :style="{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }"
            >
              <Badge :variant="STATUS_BADGE[g.status] ?? 'muted'">
                <span :style="{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }">
                  <component :is="STATUS_ICON[g.status]" :size="12" />
                  {{ g.status.replace("_", " ") }}
                </span>
              </Badge>
            </span>
          </td>
          <td :style="{ ...tdStyle, fontFamily: 'ui-monospace, monospace' }">{{ g.serviceId }}</td>
          <td :style="tdStyle">
            <div :style="{ fontWeight: 500 }">{{ g.sampleMessage }}</div>
            <div
              :style="{
                fontSize: '0.7rem',
                color: 'var(--color-text-secondary)',
                fontFamily: 'ui-monospace, monospace'
              }"
            >{{ g.fingerprint }}</div>
            <div
              v-if="g.status === 'missing_auth'"
              :style="{ marginTop: '4px', color: 'var(--color-danger)', fontSize: '0.75rem' }"
            >Auto-fix disabled: this service has no SSH key. Configure one in Services.</div>
            <div
              v-if="g.status === 'paused'"
              :style="{ marginTop: '4px', color: 'var(--color-danger)', fontSize: '0.75rem' }"
            >A previous fix did not stop this error. Auto-fix paused to avoid a loop.</div>
          </td>
          <td :style="tdStyle">{{ g.count }}</td>
          <td :style="tdStyle">{{ formatRelativeTime(g.lastSeenAt) }}</td>
          <td :style="tdStyle">
            <template v-if="g.lastFixAt">
              <div>{{ formatRelativeTime(g.lastFixAt) }}</div>
              <div
                v-if="g.lastFixCommit"
                :style="{
                  fontSize: '0.7rem',
                  color: 'var(--color-text-secondary)',
                  fontFamily: 'ui-monospace, monospace'
                }"
              >{{ g.lastFixCommit.slice(0, 12) }}</div>
            </template>
            <template v-else>—</template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
