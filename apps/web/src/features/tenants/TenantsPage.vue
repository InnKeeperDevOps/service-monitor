<script setup lang="ts">
import { computed, ref } from "vue";
import { Building2, Settings, Trash2 } from "lucide-vue-next";
import { api, meResponseToAuthUser } from "../../lib/api.js";
import { useAuth, type AuthUser } from "../../lib/useAuth.js";
import Button from "../../components/Button.vue";

const emit = defineEmits<{ authUserUpdated: [u: AuthUser] }>();

const auth = useAuth();
const memberships = computed(() => auth.value.user?.memberships ?? []);

const showCreate = ref(false);
const newName = ref("");
const newTenantId = ref("");
const createBusy = ref(false);
const createErr = ref<string | null>(null);

const deleteBusyId = ref<string | null>(null);
const deleteErr = ref<string | null>(null);

function canDeleteTenant(role: string): boolean {
  return role === "owner" || role === "admin";
}

async function submitCreate() {
  const name = newName.value.trim();
  if (!name) {
    createErr.value = "Name is required.";
    return;
  }
  createErr.value = null;
  createBusy.value = true;
  try {
    const rawId = newTenantId.value.trim();
    const me = await api.createTenant({ name, ...(rawId ? { tenantId: rawId } : {}) });
    emit("authUserUpdated", meResponseToAuthUser(me));
    newName.value = "";
    newTenantId.value = "";
    showCreate.value = false;
  } catch (e) {
    createErr.value = (e as Error).message ?? "Failed to create tenant";
  } finally {
    createBusy.value = false;
  }
}

async function confirmDelete(tenantId: string, tenantName: string) {
  if (
    !window.confirm(
      `Delete workspace “${tenantName}” (${tenantId})? This removes all data for that tenant and cannot be undone.`
    )
  ) {
    return;
  }
  deleteErr.value = null;
  deleteBusyId.value = tenantId;
  try {
    await api.deleteTenant(tenantId);
    try {
      const me = await api.me();
      emit("authUserUpdated", meResponseToAuthUser(me));
    } catch {
      api.logout();
    }
  } catch (e) {
    deleteErr.value = (e as Error).message ?? "Failed to delete tenant";
  } finally {
    deleteBusyId.value = null;
  }
}

const muted = { color: "var(--color-text-secondary)", fontSize: "0.85rem" } as const;
const rowStyle = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto auto",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.65rem 0",
  borderBottom: "1px solid var(--color-border)",
  fontSize: "0.9rem"
} as const;
</script>

<template>
  <section>
    <h2 :style="{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }">
      <Building2 :size="20" /> Tenants
    </h2>
    <p :style="{ ...muted, marginBottom: '1rem' }">
      Workspaces you belong to. Open configuration for repo defaults, automation policy, and executors.
    </p>

    <div :style="{ marginBottom: '1.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }">
      <Button v-if="!showCreate" type="button" variant="primary" size="sm" @click="showCreate = true">
        New tenant
      </Button>
      <div
        v-else
        :style="{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          padding: '0.75rem',
          border: '1px solid var(--color-border)',
          borderRadius: '8px',
          background: 'var(--color-surface-muted)',
          minWidth: 'min(100%, 320px)'
        }"
      >
        <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }">
          <span :style="{ color: 'var(--color-text-secondary)' }">Display name</span>
          <input
            v-model="newName"
            placeholder="e.g. Acme Platform"
            :style="{
              padding: '0.4rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)'
            }"
          />
        </label>
        <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }">
          <span :style="{ color: 'var(--color-text-secondary)' }">Tenant id (optional)</span>
          <input
            v-model="newTenantId"
            placeholder="t-my-org"
            :style="{
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              padding: '0.4rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)'
            }"
          />
        </label>
        <p v-if="createErr" :style="{ ...muted, color: 'var(--color-danger, #c62828)', margin: 0 }">{{ createErr }}</p>
        <div :style="{ display: 'flex', gap: '0.5rem' }">
          <Button type="button" variant="primary" size="sm" :loading="createBusy" @click="submitCreate">Create</Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="createBusy"
            @click="
              showCreate = false;
              createErr = null;
              newName = '';
              newTenantId = '';
            "
          >Cancel</Button>
        </div>
      </div>
    </div>

    <p
      v-if="deleteErr"
      :style="{ ...muted, color: 'var(--color-danger, #c62828)', marginBottom: '1rem' }"
    >{{ deleteErr }}</p>

    <p v-if="memberships.length === 0" :style="muted">No tenant memberships.</p>

    <div v-else :style="{ borderTop: '1px solid var(--color-border)' }">
      <div
        :style="{
          ...rowStyle,
          fontWeight: 600,
          color: 'var(--color-text-secondary)',
          fontSize: '0.8rem',
          paddingTop: 0
        }"
      >
        <span>Tenant</span>
        <span>Role</span>
        <span :style="{ textAlign: 'right' }">Configure</span>
        <span :style="{ textAlign: 'right' }">Delete</span>
      </div>
      <div v-for="m in memberships" :key="m.tenantId" :style="rowStyle">
        <div>
          <div :style="{ fontWeight: 600 }">{{ m.tenantName }}</div>
          <div
            :style="{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--color-text-secondary)' }"
          >{{ m.tenantId }}</div>
        </div>
        <span>{{ m.role }}</span>
        <div :style="{ textAlign: 'right' }">
          <a
            :href="`#tenant-config/${encodeURIComponent(m.tenantId)}`"
            :title="`Configure ${m.tenantName}`"
            :aria-label="`Configure tenant ${m.tenantName}`"
            :style="{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '36px',
              height: '36px',
              borderRadius: '8px',
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface-muted)',
              color: 'var(--color-text-primary)'
            }"
          >
            <Settings :size="18" />
          </a>
        </div>
        <div :style="{ textAlign: 'right' }">
          <button
            v-if="canDeleteTenant(m.role)"
            type="button"
            :title="`Delete ${m.tenantName}`"
            :aria-label="`Delete tenant ${m.tenantName}`"
            :disabled="deleteBusyId !== null"
            :style="{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '36px',
              height: '36px',
              borderRadius: '8px',
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface-muted)',
              color: 'var(--color-danger, #c62828)',
              cursor: deleteBusyId !== null ? 'wait' : 'pointer',
              opacity: deleteBusyId === m.tenantId ? 0.6 : 1
            }"
            @click="confirmDelete(m.tenantId, m.tenantName)"
          >
            <Trash2 :size="18" />
          </button>
          <span v-else :style="{ ...muted, fontSize: '0.75rem' }">—</span>
        </div>
      </div>
    </div>
  </section>
</template>
