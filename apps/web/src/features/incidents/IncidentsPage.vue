<script setup lang="ts">
import { computed, onMounted, ref, type Component } from "vue";
import { AlertTriangle, CheckCircle, Clock } from "lucide-vue-next";
import { api, type Incident } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

const statusIcon: Record<string, Component> = {
  open: AlertTriangle,
  acknowledged: Clock,
  resolved: CheckCircle,
  closed: CheckCircle
};

const statusColor: Record<string, string> = {
  open: "var(--color-danger)",
  acknowledged: "var(--color-warning)",
  resolved: "var(--color-success)",
  closed: "var(--color-text-secondary)"
};

const incidents = ref<Incident[]>([]);
const error = ref<string | null>(null);
const expandedId = ref<string | null>(null);
const auth = useAuth();
const isViewer = computed(() => auth.value.isViewer);

onMounted(async () => {
  try {
    const r = await api.listIncidents();
    incidents.value = r.incidents;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
});

async function handleStatusChange(id: string, status: string) {
  try {
    const updated = await api.updateIncidentStatus(id, status);
    incidents.value = incidents.value.map((i) => (i.id === updated.id ? updated : i));
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

const headers = computed(() =>
  isViewer.value
    ? ["Status", "Message", "Fingerprint", "Service", "First Seen", "Events"]
    : ["Status", "Message", "Fingerprint", "Service", "First Seen", "Events", "Actions"]
);

function colSpan() {
  return isViewer.value ? 6 : 7;
}

const btnStyle = {
  background: "var(--color-primary)",
  color: "var(--color-primary-foreground)",
  border: "none",
  borderRadius: "6px",
  padding: "0.25rem 0.5rem",
  fontSize: "0.8rem",
  cursor: "pointer"
};
</script>

<template>
  <section>
    <h2 :style="{ margin: '0 0 1rem' }">Incidents</h2>
    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.5rem' }">{{ error }}</div>

    <p v-if="incidents.length === 0" :style="{ color: 'var(--color-text-secondary)' }">
      No incidents recorded yet.
    </p>

    <table v-else :style="{ width: '100%', borderCollapse: 'collapse' }">
      <thead>
        <tr>
          <th
            v-for="h in headers"
            :key="h"
            :style="{
              textAlign: 'left',
              padding: '0.5rem',
              borderBottom: '2px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
              fontSize: '0.8rem'
            }"
          >
            {{ h }}
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="inc in incidents" :key="inc.id">
          <tr :style="{ cursor: 'pointer' }" @click="expandedId = expandedId === inc.id ? null : inc.id">
            <td :style="{ padding: '0.5rem' }">
              <span
                :style="{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  color: statusColor[inc.status]
                }"
              >
                <component :is="statusIcon[inc.status] ?? AlertTriangle" :size="14" />
                {{ inc.status }}
              </span>
            </td>
            <td
              :style="{
                padding: '0.5rem',
                maxWidth: '300px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }"
            >
              {{ inc.message ?? inc.fingerprint.slice(0, 16) }}
            </td>
            <td
              :style="{
                padding: '0.5rem',
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                color: 'var(--color-text-secondary)'
              }"
            >
              {{ inc.fingerprint.slice(0, 12) }}…
            </td>
            <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">{{ inc.serviceId }}</td>
            <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">
              {{ new Date(inc.firstSeenAt).toLocaleString() }}
            </td>
            <td :style="{ padding: '0.5rem', textAlign: 'center' }">{{ inc.eventCount }}</td>
            <td v-if="!isViewer" :style="{ padding: '0.5rem' }" @click.stop>
              <button
                v-if="inc.status === 'open'"
                :style="btnStyle"
                @click="handleStatusChange(inc.id, 'acknowledged')"
              >
                Acknowledge
              </button>
              <button
                v-if="inc.status === 'open' || inc.status === 'acknowledged'"
                :style="{ ...btnStyle, marginLeft: '0.25rem' }"
                @click="handleStatusChange(inc.id, 'resolved')"
              >
                Resolve
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === inc.id">
            <td
              :colspan="colSpan()"
              :style="{
                padding: '0.75rem 1rem',
                background: 'var(--color-surface-muted)',
                borderBottom: '2px solid var(--color-border)'
              }"
            >
              <div :style="{ display: 'grid', gap: '0.5rem', fontSize: '0.85rem' }">
                <div>
                  <strong>Fingerprint:</strong>
                  <code :style="{ fontSize: '0.8rem', wordBreak: 'break-all' }">{{ inc.fingerprint }}</code>
                </div>
                <div>
                  <strong>Timeline:</strong>
                  First seen {{ new Date(inc.firstSeenAt).toLocaleString() }} ·
                  Last seen {{ new Date(inc.lastSeenAt).toLocaleString() }} ·
                  {{ inc.eventCount }} event{{ inc.eventCount !== 1 ? "s" : "" }}
                </div>
                <div :style="{ display: 'flex', gap: '1rem' }">
                  <a
                    href="#agents"
                    :style="{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }"
                  >View Agents →</a>
                  <a
                    href="#settings"
                    :style="{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }"
                  >Review GitHub Policy →</a>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </section>
</template>
