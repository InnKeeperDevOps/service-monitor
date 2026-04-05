/**
 * Pure selection logic for which tenant store backend to use.
 * DATABASE_URL must be non-empty; `pgAvailable` reflects a successful `import("pg")`.
 */
export function resolveTenantStoreBackend(
  env: NodeJS.ProcessEnv,
  pgAvailable: boolean
): "postgres" | "memory" {
  const url = env.DATABASE_URL;
  if (typeof url === "string" && url.trim().length > 0 && pgAvailable) {
    return "postgres";
  }
  return "memory";
}
