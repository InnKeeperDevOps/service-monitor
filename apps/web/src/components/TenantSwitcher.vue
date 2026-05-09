<script setup lang="ts">
import { computed, type CSSProperties } from "vue";
import { Building2 } from "lucide-vue-next";
import type { AuthUser } from "../lib/useAuth.js";
import { useSwitchActiveTenant } from "../hooks/useSwitchActiveTenant.js";

const props = withDefaults(
  defineProps<{
    user: AuthUser | null;
    meResolved?: boolean;
  }>(),
  { meResolved: true }
);

const emit = defineEmits<{ userUpdated: [u: AuthUser] }>();

const { switchTenant, busy, error } = useSwitchActiveTenant((u) => emit("userUpdated", u));

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.7rem",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--color-nav-muted)",
  marginBottom: "0.35rem",
  paddingLeft: "0.05rem"
};

const selectStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.5rem",
  fontSize: "0.85rem",
  color: "var(--color-nav-text)",
  background: "var(--color-nav-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  cursor: "pointer",
  outline: "none"
};

const memberships = computed(() => {
  const u = props.user;
  if (!u) return [];
  const raw =
    u.memberships.length > 0 ? u.memberships : [{ tenantId: u.tenantId, tenantName: u.tenantId, role: u.role }];
  return [...raw].sort((a, b) => a.tenantName.localeCompare(b.tenantName, undefined, { sensitivity: "base" }));
});

function onChange(ev: Event) {
  const next = (ev.target as HTMLSelectElement).value;
  const u = props.user;
  if (next && u && next !== u.tenantId) {
    void switchTenant(next).catch(() => undefined);
  }
}
</script>

<template>
  <div v-if="!meResolved" :style="{ padding: '0 1rem 0.75rem' }">
    <div :style="labelStyle" aria-hidden>
      <span :style="{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }">
        <Building2 :size="12" aria-hidden /> Workspace
      </span>
    </div>
    <div
      data-testid="nav-workspace-loading"
      :style="{ ...selectStyle, opacity: 0.65, cursor: 'wait', display: 'flex', alignItems: 'center' }"
      aria-busy="true"
    >
      Loading…
    </div>
  </div>

  <div
    v-else-if="!user"
    :style="{ padding: '0 1rem 0.75rem', fontSize: '0.75rem', color: 'var(--color-danger)' }"
    role="status"
  >
    Workspace unavailable — try refreshing the page.
  </div>

  <div v-else :style="{ padding: '0 1rem 0.75rem' }">
    <div :style="labelStyle" aria-hidden>
      <span :style="{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }">
        <Building2 :size="12" aria-hidden /> Workspace
      </span>
    </div>
    <select
      data-testid="nav-workspace-select"
      aria-label="Select workspace"
      :disabled="busy"
      :value="user.tenantId"
      :style="{ ...selectStyle, opacity: busy ? 0.7 : 1, cursor: busy ? 'wait' : 'pointer' }"
      @change="onChange"
    >
      <option v-for="m in memberships" :key="m.tenantId" :value="m.tenantId">
        {{ m.tenantName }}
      </option>
    </select>
    <p
      v-if="error"
      role="alert"
      :style="{ margin: '0.35rem 0 0', fontSize: '0.75rem', color: 'var(--color-danger)' }"
    >
      {{ error }}
    </p>
  </div>
</template>
