import { ref } from "vue";
import { api, meResponseToAuthUser } from "../lib/api.js";
import type { AuthUser } from "../lib/useAuth.js";

export function useSwitchActiveTenant(onUserUpdated: (u: AuthUser) => void) {
  const busy = ref(false);
  const error = ref<string | null>(null);

  async function switchTenant(tenantId: string) {
    error.value = null;
    busy.value = true;
    try {
      const me = await api.switchActiveTenant(tenantId);
      onUserUpdated(meResponseToAuthUser(me));
    } catch (e) {
      const msg = (e as Error).message ?? "Failed to switch workspace";
      error.value = msg;
      throw e;
    } finally {
      busy.value = false;
    }
  }

  return { switchTenant, busy, error };
}
