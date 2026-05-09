<script setup lang="ts">
import type { TenantSettings } from "@sm/contracts";
import { Building2 } from "lucide-vue-next";
import { ref, watch } from "vue";
import type { TenantSettingsPatch } from "./mergeTenantSettings.js";

const props = defineProps<{
  tenantId: string;
  canEdit: boolean;
  data: TenantSettings | null;
  loading: boolean;
  error: string | null;
  isSaving: boolean;
  savePatch: (patch: TenantSettingsPatch) => Promise<void>;
  onClearError: () => void;
}>();

const docsUrl = ref("");
const preferredExecutor = ref<"" | "cursor" | "claude">("");

watch(
  () => props.data,
  (d) => {
    if (d) {
      docsUrl.value = d.docsUrl ?? "";
      preferredExecutor.value = d.preferredExecutor ?? "";
    } else {
      docsUrl.value = "";
      preferredExecutor.value = "";
    }
  },
  { immediate: true }
);

async function handleSubmit(e: Event) {
  e.preventDefault();
  props.onClearError();
  try {
    await props.savePatch({
      docsUrl: docsUrl.value.trim() ? docsUrl.value.trim() : null,
      preferredExecutor: preferredExecutor.value === "" ? null : preferredExecutor.value
    });
  } catch {
    /* error shown via prop */
  }
}

const sectionStyle = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "10px",
  padding: "1rem",
  marginBottom: "1rem"
} as const;
const inputStyle = {
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  padding: "0.35rem 0.45rem",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)",
  width: "100%",
  maxWidth: "420px",
  boxSizing: "border-box"
} as const;
</script>

<template>
  <div :style="sectionStyle">
    <h3
      :style="{
        margin: '0 0 0.75rem',
        fontSize: '1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem'
      }"
    >
      <Building2 :size="16" /> Tenant Configuration
    </h3>
    <p v-if="loading" :style="{ color: 'var(--color-text-secondary)', margin: 0, fontSize: '0.85rem' }">
      Loading tenant settings…
    </p>
    <p v-if="error" :style="{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0 0 0.75rem' }">
      {{ error }}
    </p>
    <p
      v-if="!canEdit"
      :style="{ color: 'var(--color-text-secondary)', margin: '0 0 0.75rem', fontSize: '0.85rem' }"
    >
      Only owners, admins, and operators can change tenant settings. Viewers see the current configuration only.
    </p>

    <form @submit="handleSubmit">
      <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem', marginBottom: '0.65rem' }">
        <span :style="{ color: 'var(--color-text-secondary)' }">Tenant ID</span>
        <input :value="tenantId" readonly :style="{ ...inputStyle, opacity: 0.85 }" aria-label="Tenant ID" />
      </label>
      <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem', marginBottom: '0.65rem' }">
        <span :style="{ color: 'var(--color-text-secondary)' }">Documentation URL (optional)</span>
        <input
          v-model="docsUrl"
          :disabled="!canEdit || loading || isSaving"
          placeholder="https://docs.example.com"
          :style="{ ...inputStyle, maxWidth: '100%' }"
          aria-label="Documentation URL"
          type="url"
        />
      </label>
      <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem', marginBottom: '0.65rem' }">
        <span :style="{ color: 'var(--color-text-secondary)' }">Preferred executor (optional)</span>
        <select
          v-model="preferredExecutor"
          :disabled="!canEdit || loading || isSaving"
          aria-label="Preferred executor"
          :style="{
            border: '1px solid var(--color-border)',
            borderRadius: '6px',
            padding: '0.35rem 0.45rem',
            background: 'var(--color-surface)',
            color: 'var(--color-text-primary)',
            maxWidth: '420px'
          }"
        >
          <option value="">No preference</option>
          <option value="cursor">Cursor</option>
          <option value="claude">Claude</option>
        </select>
      </label>

      <button
        type="submit"
        :disabled="!canEdit || loading || isSaving"
        :style="{
          background: 'var(--color-primary)',
          color: 'var(--color-primary-foreground)',
          border: 'none',
          borderRadius: '6px',
          padding: '0.45rem 0.8rem',
          fontSize: '0.85rem',
          cursor: !canEdit || loading || isSaving ? 'not-allowed' : 'pointer',
          opacity: !canEdit || loading || isSaving ? 0.75 : 1,
          marginTop: '0.25rem'
        }"
      >
        {{ isSaving ? "Saving…" : "Save tenant settings" }}
      </button>
    </form>
  </div>
</template>
