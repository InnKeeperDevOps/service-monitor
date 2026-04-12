import { agentHelloMessageSchema, type TenantSettings } from "@sm/contracts";

/** Builds the first WebSocket frame for enrolled agents (runtime + workload policy from tenant settings). */
export function buildRealtimeAgentHello(settings: TenantSettings | undefined) {
  let runtimeBackend: "docker" | "kubernetes" | "shell" = "docker";
  if (settings?.agentRuntimeBackend) {
    runtimeBackend = settings.agentRuntimeBackend;
  }

  let configReady = true;
  let workloadSource: "git_repo" | "binary" | null = "git_repo";

  if (settings) {
    const raw = settings.agentWorkloadSource;
    if (raw === undefined) {
      configReady = true;
      workloadSource = "git_repo";
    } else if (raw === null) {
      configReady = false;
      workloadSource = null;
    } else {
      configReady = true;
      workloadSource = raw;
    }
  }

  try {
    return agentHelloMessageSchema.parse({
      type: "hello",
      service: "realtime",
      runtime: { backend: runtimeBackend },
      configReady,
      ...(settings?.preferredExecutor ? { preferredExecutor: settings.preferredExecutor } : {}),
      workload: {
        source: workloadSource,
        gitRepoUrl: settings?.gitRepoUrl ?? "",
        sshKeyId: settings?.sshKeyId ?? null,
        defaultBranch: settings?.defaultBranch ?? ""
      }
    });
  } catch (e) {
    console.error("Parse Error in buildRealtimeAgentHello:", e);
    throw e;
  }
}
