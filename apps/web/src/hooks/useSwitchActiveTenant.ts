import { useCallback, useState } from "react";
import { api, meResponseToAuthUser } from "../lib/api.js";
import type { AuthUser } from "../lib/useAuth.js";

export function useSwitchActiveTenant(onUserUpdated: (u: AuthUser) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchTenant = useCallback(
    async (tenantId: string) => {
      setError(null);
      setBusy(true);
      try {
        const me = await api.switchActiveTenant(tenantId);
        onUserUpdated(meResponseToAuthUser(me));
      } catch (e) {
        const msg = (e as Error).message ?? "Failed to switch workspace";
        setError(msg);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [onUserUpdated]
  );

  return { switchTenant, busy, error };
}
