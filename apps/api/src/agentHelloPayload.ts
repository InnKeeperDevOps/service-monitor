import { agentHelloMessageSchema, type TenantSettings } from "@sm/contracts";

/** Builds the first WebSocket frame for enrolled agents (runtime + workload policy from tenant settings). */
export function buildRealtimeAgentHello(settings: TenantSettings | undefined) {
  let runtimeBackend: "docker" | "kubernetes" | "shell" = "docker";
  if (settings?.agentRuntimeBackend) {
    runtimeBackend = settings.agentRuntimeBackend;
  }

  try {
    return agentHelloMessageSchema.parse({
      type: "hello",
      service: "realtime",
      runtime: { backend: runtimeBackend },
      ...(settings?.preferredExecutor ? { preferredExecutor: settings.preferredExecutor } : {})
    });
  } catch (e) {
    console.error("Parse Error in buildRealtimeAgentHello:", e);
    throw e;
  }
}
