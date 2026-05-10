<script setup lang="ts">
import { computed, onMounted, ref, watch, type CSSProperties } from "vue";
import { api, type MonitoredService } from "../../lib/api.js";

const props = defineProps<{
  agentId: string;
  allServices: MonitoredService[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ change: [] }>();

const pickerValue = ref("");
const busy = ref<string | null>(null);
const error = ref<string | null>(null);

// Snapshot of "what version of each service is currently running on
// this agent" — populated by the agent's lb_status_report after every
// successful redeploy. Map keyed by serviceId; one entry per env in
// the service_loadbalancer_status table.
type RunningEntry = {
  serviceId: string;
  environment: string;
  namespace: string;
  imageRef: string | null;
  buildId: string | null;
  observedAt: string;
};
const running = ref<RunningEntry[]>([]);

async function loadRunning() {
  try {
    const r = await api.listRunningServicesForAgent(props.agentId);
    running.value = r.running;
  } catch {
    // Non-fatal — section still renders the bound list.
    running.value = [];
  }
}

onMounted(loadRunning);
watch(() => props.agentId, loadRunning);

function runningForService(serviceId: string): RunningEntry[] {
  return running.value.filter((r) => r.serviceId === serviceId);
}

function shortSha(ref: string | null): string {
  if (!ref) return "—";
  // Pull a short SHA out of "host/repo:abcd1234..." or
  // "host/repo@sha256:abcd...". Falls back to the last 12 chars.
  const colon = ref.lastIndexOf(":");
  const tag = colon >= 0 ? ref.slice(colon + 1) : ref;
  if (tag.length > 12) return tag.slice(0, 12);
  return tag;
}

const bound = computed(() =>
  props.allServices.filter((s) => s.agents?.some((a) => a.agentId === props.agentId))
);
const unbound = computed(() =>
  props.allServices.filter((s) => !s.agents?.some((a) => a.agentId === props.agentId))
);

async function handleAttach() {
  if (!pickerValue.value) return;
  error.value = null;
  busy.value = pickerValue.value;
  try {
    await api.attachServiceToAgent(props.agentId, pickerValue.value);
    pickerValue.value = "";
    emit("change");
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

async function handleDetach(serviceId: string) {
  error.value = null;
  busy.value = serviceId;
  try {
    await api.detachServiceFromAgent(props.agentId, serviceId);
    emit("change");
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

const subhead: CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "0.85rem",
  color: "var(--color-text-secondary)"
};
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.4rem 0.5rem",
  borderTop: "1px solid var(--color-border)",
  fontSize: "0.85rem"
};
function btn(variant: "primary" | "muted" | "danger" = "muted"): CSSProperties {
  const base: CSSProperties = {
    border: "1px solid var(--color-border)",
    borderRadius: "4px",
    padding: "0.2rem 0.55rem",
    cursor: "pointer",
    fontSize: "0.78rem"
  };
  if (variant === "primary") {
    return {
      ...base,
      background: "var(--color-primary)",
      color: "var(--color-primary-foreground)",
      borderColor: "var(--color-primary)"
    };
  }
  if (variant === "danger") {
    return { ...base, background: "var(--color-surface)", color: "var(--color-danger)" };
  }
  return { ...base, background: "var(--color-surface)", color: "var(--color-text-primary)" };
}
</script>

<template>
  <section :style="{ marginTop: '0.75rem' }">
    <h4 :style="subhead">Services bound to this agent</h4>

    <div
      v-if="error"
      role="alert"
      :style="{ color: 'var(--color-danger)', fontSize: '0.8rem', marginBottom: '0.5rem' }"
    >{{ error }}</div>

    <p
      v-if="bound.length === 0"
      :style="{ color: 'var(--color-text-secondary)', fontSize: '0.82rem', margin: '0 0 0.5rem' }"
    >No services bound. Pick one below to attach.</p>

    <div
      v-else
      role="list"
      :style="{
        border: '1px solid var(--color-border)',
        borderRadius: '6px',
        marginBottom: '0.5rem',
        background: 'var(--color-surface)'
      }"
    >
      <div
        v-for="(svc, i) in bound"
        :key="svc.id"
        role="listitem"
        :style="{
          ...rowStyle,
          ...(i === 0 ? { borderTop: 'none' } : {}),
          flexWrap: 'wrap'
        }"
      >
        <span :style="{ fontWeight: 600, minWidth: '160px' }">{{ svc.name }}</span>
        <span
          :style="{
            color: 'var(--color-text-secondary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: '160px'
          }"
          :title="svc.gitRepoUrl"
        >{{ svc.gitRepoUrl }}</span>
        <span :style="{ color: 'var(--color-text-secondary)', minWidth: '60px' }">{{ svc.branch }}</span>
        <button
          v-if="!disabled"
          type="button"
          :disabled="busy === svc.id"
          :style="btn('danger')"
          @click="handleDetach(svc.id)"
        >{{ busy === svc.id ? "Detaching…" : "Detach" }}</button>

        <!-- Running-version rows: one per (service, env). Empty list
             means the agent has never reported a successful redeploy
             for this service yet. -->
        <div
          v-if="runningForService(svc.id).length > 0"
          :style="{
            flexBasis: '100%',
            paddingLeft: '0.25rem',
            paddingTop: '0.2rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.15rem'
          }"
        >
          <div
            v-for="r in runningForService(svc.id)"
            :key="`${r.serviceId}-${r.environment}`"
            :style="{
              fontSize: '0.78rem',
              color: 'var(--color-text-secondary)',
              fontFamily: 'var(--font-mono)'
            }"
            :title="r.imageRef ?? ''"
          >
            running
            <span :style="{ color: 'var(--color-text-primary)' }">{{ shortSha(r.imageRef) }}</span>
            <span :style="{ marginLeft: '0.5rem' }">env={{ r.environment }}</span>
            <span v-if="r.namespace" :style="{ marginLeft: '0.5rem' }">ns={{ r.namespace }}</span>
            <span :style="{ marginLeft: '0.5rem' }">
              · {{ new Date(r.observedAt).toLocaleString() }}
            </span>
          </div>
        </div>
        <div
          v-else
          :style="{
            flexBasis: '100%',
            paddingLeft: '0.25rem',
            fontSize: '0.78rem',
            color: 'var(--color-text-secondary)',
            fontStyle: 'italic'
          }"
        >no version reported yet · trigger a build to deploy</div>
      </div>
    </div>

    <div
      v-if="!disabled"
      :style="{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }"
    >
      <select
        v-model="pickerValue"
        aria-label="Pick a service to bind to this agent"
        :disabled="unbound.length === 0"
        :style="{
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          color: 'var(--color-text-primary)',
          borderRadius: '4px',
          padding: '0.2rem 0.4rem',
          fontSize: '0.82rem',
          minWidth: '220px'
        }"
      >
        <option value="">
          {{ unbound.length === 0 ? "All services already bound" : "— pick a service —" }}
        </option>
        <option v-for="svc in unbound" :key="svc.id" :value="svc.id">{{ svc.name }}</option>
      </select>
      <button
        type="button"
        :disabled="!pickerValue || busy !== null"
        :style="btn('primary')"
        @click="handleAttach"
      >+ Bind</button>
    </div>
  </section>
</template>
