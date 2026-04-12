import { tenantSettingsSchema, type TenantSettings } from "@sm/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { mergeTenantSettings, type TenantSettingsPatch } from "./mergeTenantSettings.js";

export function useTenantSettings(tenantId: string | null) {
  const [data, setData] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const dataRef = useRef<TenantSettings | null>(null);
  dataRef.current = data;

  const reload = useCallback(async () => {
    if (!tenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const s = await api.getSettings();
      setData(s);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const savePatch = useCallback(
    async (patch: TenantSettingsPatch) => {
      if (!tenantId) {
        return;
      }
      setIsSaving(true);
      setError(null);
      try {
        const base: TenantSettings = dataRef.current ?? { tenantId };
        const merged = mergeTenantSettings(base, patch);
        const parsed = tenantSettingsSchema.safeParse(merged);
        if (!parsed.success) {
          const msg = parsed.error.issues.map((issue) => issue.message).join("; ");
          setError(msg);
          throw new Error(msg);
        }
        const saved = await api.updateSettings(parsed.data);
        setData(saved);
      } catch (e) {
        const msg = (e as Error).message;
        setError(msg);
        throw e;
      } finally {
        setIsSaving(false);
      }
    },
    [tenantId]
  );

  const clearError = useCallback(() => setError(null), []);

  return { data, loading, error, isSaving, reload, savePatch, clearError };
}
