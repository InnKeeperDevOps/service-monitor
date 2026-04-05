import type { AutomationAction, AutomationPolicy } from "@sm/contracts";

export type PolicyGuardedResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Evaluates whether a GitHub mutation action is permitted
 * by the tenant's automation policy.
 */
export function policyGuardedMutation(
  policy: AutomationPolicy | undefined,
  repo: string,
  branch: string,
  action: AutomationAction
): PolicyGuardedResult {
  if (!policy) {
    return { allowed: false, reason: "POLICY_NOT_CONFIGURED" };
  }
  if (!policy.repos.includes(repo)) {
    return { allowed: false, reason: "REPO_NOT_ALLOWLISTED" };
  }
  if (!policy.branches.includes(branch)) {
    return { allowed: false, reason: "BRANCH_NOT_ALLOWLISTED" };
  }
  if (!policy.actions.includes(action)) {
    return { allowed: false, reason: "ACTION_NOT_ALLOWLISTED" };
  }
  return { allowed: true };
}
