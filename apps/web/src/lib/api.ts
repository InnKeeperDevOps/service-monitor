const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:3001" : "");

function getAuthToken(): string {
  return localStorage.getItem("sm_token") ?? import.meta.env.VITE_AUTH_TOKEN ?? "dev-token";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined)
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
    throw new Error(body.message ?? `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type Incident = {
  id: string;
  tenantId: string;
  serviceId: string;
  fingerprint: string;
  status: string;
  message?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  eventCount: number;
};

export type Agent = {
  id: string;
  tenantId: string;
  name: string | null;
  version: string | null;
  status: string;
  lastSeenAt: string | null;
  certFingerprint?: string | null;
  allowedCapabilities?: string[];
};

export type MonitoredService = {
  id: string;
  tenantId: string;
  name: string;
  repo: string;
  branch: string;
  agentId: string | null;
  dockerImage?: string | null;
  composePath?: string | null;
};

export type WorkflowGraph = {
  id: string;
  serviceId: string;
  nodes: { id: string; type: string }[];
  edges: { from: string; to: string }[];
};

export type WorkflowExecutionResponse = {
  accepted: true;
  workflowId: string;
  workflowVersion: number;
  agentId: string;
  commandId: string;
  dispatchState: "queued_for_dispatch";
};

export const api = {
  login: (email: string, password: string) =>
    apiFetch<{ token: string }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),

  logout: () => {
    localStorage.removeItem("sm_token");
    window.location.reload();
  },

  me: () => apiFetch<{ id: string; email: string; role: string; tenantId: string }>("/api/v1/me"),
  listIncidents: () => apiFetch<{ incidents: Incident[] }>("/api/v1/incidents"),
  updateIncidentStatus: (id: string, status: string) =>
    apiFetch<Incident>(`/api/v1/incidents/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }),
  listAgents: () => apiFetch<{ agents: Agent[] }>("/api/v1/agents"),
  listServices: () => apiFetch<{ services: MonitoredService[] }>("/api/v1/services"),
  createService: (data: {
    name: string;
    repo: string;
    branch: string;
    dockerImage?: string;
    composePath?: string;
  }) =>
    apiFetch<MonitoredService>("/api/v1/services", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  createWorkflow: (data: { serviceId: string; nodes: { id: string; type: string }[]; edges: { from: string; to: string }[] }) =>
    apiFetch<WorkflowGraph>("/api/v1/workflows", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  executeWorkflow: (data: { serviceId: string; nodes: { id: string; type: string }[]; edges: { from: string; to: string }[] }) =>
    apiFetch<WorkflowExecutionResponse>("/api/v1/workflows/execute", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  listWorkflows: () => apiFetch<{ graphs: WorkflowGraph[] }>("/api/v1/workflows"),
  getSettings: () => apiFetch<Record<string, unknown>>("/api/v1/settings").catch(() => null),
  updateSettings: (data: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>("/api/v1/settings", {
      method: "POST",
      body: JSON.stringify(data)
    }),
  listEnrollmentTokens: () =>
    apiFetch<{ tokens: { id: string; tenantId: string; expiresAt: string; createdBy: string; usedAt: string | null }[] }>(
      "/api/v1/agents/enrollment-tokens"
    ),

  listGithubInstallations: () =>
    apiFetch<{ installations: { installationId: number; accountLogin: string; repos?: string[] }[] }>(
      "/api/v1/github/installations"
    ).catch(() => ({ installations: [] })),

  syncGithubInstallation: (installationId: number) =>
    apiFetch<{ installationId: number; accountLogin: string; appId: number }>(
      "/api/v1/github/installations/sync",
      {
        method: "POST",
        body: JSON.stringify({ installationId })
      }
    ),

  getAuthProviders: () =>
    apiFetch<{ providers: { id: string; name: string; type: string }[] }>("/api/v1/auth/providers"),

  getOAuthAuthorizeUrl: (providerId: string) =>
    apiFetch<{ authorizeUrl: string }>(`/api/v1/auth/oauth/authorize?provider=${encodeURIComponent(providerId)}`),

  handleOAuthCallback: (code: string, state: string) =>
    apiFetch<{ token: string }>(`/api/v1/auth/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`)
};
