import { tenantSettingsSchema, type TenantSettings } from "@sm/contracts";
import { ref, watch } from "vue";
import { api } from "../../lib/api.js";
import { mergeTenantSettings, type TenantSettingsPatch } from "./mergeTenantSettings.js";

export function useTenantSettings(tenantId: () => string | null) {
  const data = ref<TenantSettings | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const isSaving = ref(false);

  async function reload() {
    const tid = tenantId();
    if (!tid) {
      data.value = null;
      loading.value = false;
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      const s = await api.getSettings();
      data.value = s;
    } catch (e) {
      error.value = (e as Error).message;
      data.value = null;
    } finally {
      loading.value = false;
    }
  }

  watch(tenantId, () => void reload(), { immediate: true });

  async function savePatch(patch: TenantSettingsPatch) {
    const tid = tenantId();
    if (!tid) return;
    isSaving.value = true;
    error.value = null;
    try {
      const base: TenantSettings = data.value ?? { tenantId: tid };
      const merged = mergeTenantSettings(base, patch);
      const parsed = tenantSettingsSchema.safeParse(merged);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((issue) => issue.message).join("; ");
        error.value = msg;
        throw new Error(msg);
      }
      const saved = await api.updateSettings(parsed.data);
      data.value = saved;
    } catch (e) {
      const msg = (e as Error).message;
      error.value = msg;
      throw e;
    } finally {
      isSaving.value = false;
    }
  }

  function clearError() {
    error.value = null;
  }

  return { data, loading, error, isSaving, reload, savePatch, clearError };
}
