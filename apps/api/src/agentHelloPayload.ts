import { agentHelloMessageSchema, type TenantSettings } from "@sm/contracts";

/** Builds the first WebSocket frame for enrolled agents (runtime + workload policy from tenant settings). */
export function buildRealtimeAgentHello(settings: TenantSettings | undefined) {
  let runtimeBackend: "docker" | "kubernetes" | "shell" = "docker";
  if (settings?.agentRuntimeBackend) {
    runtimeBackend = settings.agentRuntimeBackend;
  }

  let configReady = true;
  let workloadSource: "github_repo" | "binary" | null = "github_repo";

  if (settings) {
    const raw = settings.agentWorkloadSource;
    if (raw === undefined) {
      configReady = true;
      workloadSource = "github_repo";
    } else if (raw === null) {
      configReady = false;
      workloadSource = null;
    } else {
      configReady = true;
      workloadSource = raw;
    }
  }

  return agentHelloMessageSchema.parse({
    type: "hello",
    service: "realtime",
    runtime: { backend: runtimeBackend },
    configReady,
    workload: {
      source: workloadSource,
      githubRepo: settings?.githubRepo ?? "",
      defaultBranch: settings?.defaultBranch ?? ""
    }
  });
}
