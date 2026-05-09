<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ArrowLeft, Cpu, Settings } from "lucide-vue-next";
import { api, meResponseToAuthUser } from "../../lib/api.js";
import { useAuth, type AuthUser } from "../../lib/useAuth.js";
import TenantConfigurationSection from "../settings/TenantConfigurationSection.vue";
import { useTenantSettings } from "../settings/useTenantSettings.js";

const props = defineProps<{ tenantIdFromRoute: string }>();
const emit = defineEmits<{ authUserUpdated: [u: AuthUser] }>();

const auth = useAuth();
const switchErr = ref<string | null>(null);

const allowed = computed(
  () => auth.value.user?.memberships.some((m) => m.tenantId === props.tenantIdFromRoute) ?? false
);
const aligned = computed(() => Boolean(auth.value.user && auth.value.user.tenantId === props.tenantIdFromRoute));

const canManageTenantSettings = computed(
  () => auth.value.role === "owner" || auth.value.role === "admin" || auth.value.role === "operator"
);

const tenantSettings = useTenantSettings(() => (aligned.value ? props.tenantIdFromRoute : null));

const displayName = computed(
  () =>
    auth.value.user?.memberships.find((m) => m.tenantId === props.tenantIdFromRoute)?.tenantName ??
    props.tenantIdFromRoute
);

let cancelled = false;

async function ensureSwitched() {
  const u = auth.value.user;
  if (!u) return;
  if (!u.memberships.some((m) => m.tenantId === props.tenantIdFromRoute)) {
    window.location.hash = "tenants";
    return;
  }
  if (u.tenantId === props.tenantIdFromRoute) {
    switchErr.value = null;
    return;
  }
  try {
    const me = await api.switchActiveTenant(props.tenantIdFromRoute);
    if (!cancelled) {
      emit("authUserUpdated", meResponseToAuthUser(me));
      switchErr.value = null;
    }
  } catch (e) {
    if (!cancelled) switchErr.value = (e as Error).message;
  }
}

watch(
  () => [auth.value.user, props.tenantIdFromRoute],
  () => void ensureSwitched(),
  { immediate: true }
);

onMounted(() => {
  cancelled = false;
});
</script>

<template>
  <section v-if="allowed">
    <div :style="{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }">
      <a
        href="#tenants"
        :style="{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          color: 'var(--color-text-secondary)',
          textDecoration: 'none',
          fontSize: '0.9rem'
        }"
      >
        <ArrowLeft :size="18" aria-hidden /> Tenants
      </a>
    </div>

    <h2 :style="{ margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }">
      <Settings :size="20" /> {{ displayName }}
    </h2>
    <p
      :style="{
        color: 'var(--color-text-secondary)',
        margin: '0 0 1rem',
        fontSize: '0.85rem'
      }"
    >
      <span :style="{ fontFamily: 'monospace', fontSize: '0.8rem' }">{{ tenantIdFromRoute }}</span>
    </p>

    <div v-if="switchErr" :style="{ color: 'var(--color-danger)', marginBottom: '0.75rem' }" role="alert">
      {{ switchErr }}
    </div>

    <p
      v-if="!aligned && !switchErr"
      :style="{ color: 'var(--color-text-secondary)', margin: '0 0 1rem', fontSize: '0.85rem' }"
    >Switching to this tenant…</p>

    <TenantConfigurationSection
      v-if="aligned && auth.user?.tenantId"
      :tenant-id="auth.user.tenantId"
      :can-edit="canManageTenantSettings"
      :data="tenantSettings.data.value"
      :loading="tenantSettings.loading.value"
      :error="tenantSettings.error.value"
      :is-saving="tenantSettings.isSaving.value"
      :save-patch="tenantSettings.savePatch"
      :on-clear-error="tenantSettings.clearError"
    />

    <div
      v-if="aligned"
      :style="{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '1rem',
        marginBottom: '1rem'
      }"
    >
      <h3 :style="{ margin: '0 0 0.75rem', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }">
        <Cpu :size="16" /> Executors
      </h3>
      <p :style="{ color: 'var(--color-text-secondary)', margin: 0, fontSize: '0.85rem' }">
        Preferred executor:
        <strong>{{ tenantSettings.data.value?.preferredExecutor === "claude" ? "Claude" : "Cursor" }}</strong>
        (fallback:
        {{ tenantSettings.data.value?.preferredExecutor === "claude" ? "Cursor" : "Claude" }}). Set in the
        <strong>Tenant configuration</strong> form above.
      </p>
    </div>
  </section>
</template>
