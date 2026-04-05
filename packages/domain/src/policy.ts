export type AutomationAction = "create_pr" | "merge_pr" | "dispatch_workflow" | "push";

export interface AutomationPolicy {
  repos: string[];
  branches: string[];
  actions: AutomationAction[];
}

export function isActionAllowed(
  policy: AutomationPolicy,
  repo: string,
  branch: string,
  action: AutomationAction
): boolean {
  return policy.repos.includes(repo) && policy.branches.includes(branch) && policy.actions.includes(action);
}
