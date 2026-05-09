<script setup lang="ts">
import { computed, ref, type CSSProperties } from "vue";
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
        :style="{ ...rowStyle, ...(i === 0 ? { borderTop: 'none' } : {}) }"
      >
        <span :style="{ fontWeight: 600, minWidth: '160px' }">{{ svc.name }}</span>
        <span
          :style="{
            color: 'var(--color-text-secondary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
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
