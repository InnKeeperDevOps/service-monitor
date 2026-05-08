import crypto from "node:crypto";
import type { AgentCommandJob, ErrorGroup, MonitoredService, SshKey } from "@sm/contracts";
import type { DomainStore } from "./domainStore.js";
import type { ErrorGroupStore } from "./errorGrouping.js";

export type DispatchOutcome =
  | { kind: "dispatched"; commandId: string; agentId: string }
  | { kind: "skipped_missing_auth" }
  | { kind: "skipped_no_agent" }
  | { kind: "skipped_no_online_agent" }
  | { kind: "skipped_paused" }
  | { kind: "skipped_in_flight" }
  | { kind: "skipped_no_repo" };

export interface AutoFixDispatcherDeps {
  domainStore: DomainStore;
  errorGroups: ErrorGroupStore;
  /** Reads the raw private key for an SSH key id (only the agent uses it).
   *  When the key type is `local_path`, returns null and the path is sent
   *  in `localPath` instead. */
  readSshKeyMaterial: (tenantId: string, sshKeyId: string) => Promise<{
    type: SshKey["type"];
    privateKey: string | null;
    localPath: string | null;
  } | null>;
  enqueueAgentCommand: (job: AgentCommandJob) => Promise<void> | void;
  /**
   * Returns true if the agent has a live realtime session. Used to pick a
   * recipient from a service's many bound agents — the first online wins.
   * If none are online, the dispatcher reports `skipped_no_online_agent`
   * rather than queueing a command no one will execute.
   */
  isAgentOnline: (agentId: string) => boolean;
}

/**
 * Dispatch a `run_fix_plan` agent command for an error group. Returns a
 * tagged outcome so the caller can broadcast the right status to the UI.
 *
 * The dispatcher is responsible for ALL gating (auth/agent/state) so the
 * server's WS handler stays a thin pipe.
 */
export async function dispatchAutoFix(
  deps: AutoFixDispatcherDeps,
  group: ErrorGroup,
  service: MonitoredService | undefined
): Promise<DispatchOutcome> {
  if (group.status === "paused") {
    return { kind: "skipped_paused" };
  }
  if (group.status === "fixing") {
    return { kind: "skipped_in_flight" };
  }
  if (!service) {
    return { kind: "skipped_no_agent" };
  }
  const bindings = service.agents ?? [];
  if (bindings.length === 0) {
    return { kind: "skipped_no_agent" };
  }
  // Pick the first bound agent that's currently online. Round-robin /
  // load-balanced strategies are a future iteration — see plan
  // docs/superpowers/plans/2026-05-08-multi-agent-service-binding-plan.md.
  const targetAgentId = bindings.map((b) => b.agentId).find((id) => deps.isAgentOnline(id));
  if (!targetAgentId) {
    return { kind: "skipped_no_online_agent" };
  }
  if (!service.gitRepoUrl) {
    return { kind: "skipped_no_repo" };
  }
  if (!service.sshKeyId) {
    deps.errorGroups.setStatus(group.id, "missing_auth");
    return { kind: "skipped_missing_auth" };
  }

  const keyMaterial = await deps.readSshKeyMaterial(service.tenantId, service.sshKeyId);
  if (!keyMaterial) {
    deps.errorGroups.setStatus(group.id, "missing_auth");
    return { kind: "skipped_missing_auth" };
  }

  const commandId = `cmd-${crypto.randomUUID()}`;
  const contextLines = deps.errorGroups.contextLinesFor(group.id);
  const payload = {
    type: "run_fix_plan",
    commandId,
    errorGroupId: group.id,
    errorMessage: group.sampleMessage,
    normalizedMessage: group.normalizedMessage,
    fingerprint: group.fingerprint,
    contextLines,
    gitRepoUrl: service.gitRepoUrl,
    branch: service.branch || "main",
    sshKeyType: keyMaterial.type,
    sshKeyValue: keyMaterial.privateKey ?? keyMaterial.localPath ?? null,
    serviceId: service.id
  };

  deps.errorGroups.setStatus(group.id, "fixing");
  await deps.enqueueAgentCommand({
    agentId: targetAgentId,
    commandId,
    payload
  });
  return { kind: "dispatched", commandId, agentId: targetAgentId };
}
