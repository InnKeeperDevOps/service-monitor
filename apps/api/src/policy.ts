import { isActionAllowed, type AutomationPolicy, type AutomationAction } from "@sm/domain";

export function enforcePolicy(
  policy: AutomationPolicy,
  input: { repo: string; branch: string; action: AutomationAction }
): { allowed: true } | { allowed: false; reason: string } {
  if (!isActionAllowed(policy, input.repo, input.branch, input.action)) {
    return { allowed: false, reason: "POLICY_DENY" };
  }
  return { allowed: true };
}
