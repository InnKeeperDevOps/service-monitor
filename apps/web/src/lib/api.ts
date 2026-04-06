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
  if (res.status === 204) {
    return undefined as T;
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
  workflowGraphId?: string | null;
  dockerImage?: string | null;
  composePath?: string | null;
};

export type WorkflowGraphNode = {
  id: string;
  position?: { x: number; y: number };
} & (
  | { type: "onBuild"; data?: { displayName?: string } }
  | { type: "onStartup"; data?: { displayName?: string } }
  | { type: "onCrash"; data?: { displayName?: string } }
  | { type: "onShutdown"; data?: { displayName?: string } }
  | { type: "onLogPattern"; data: { filter: string; displayName?: string } }
  | { type: "onSchedule"; data: { schedule: string; displayName?: string } }
  | {
      type: string;
      data?: Record<string, unknown>;
    }
);

export type WorkflowGraph = {
  id: string;
  tenantId: string;
  serviceId: string;
  version: number;
  nodes: WorkflowGraphNode[];
  edges: { from: string; to: string }[];
  viewport?: { x: number; y: number; zoom: number };
  isActive: boolean;
};

export type WorkflowExecutionResponse = {
  accepted: true;
  workflowId: string;
  workflowVersion: number;
  agentId: string;
  commandId: string;
  dispatchState: "queued_for_dispatch";
};

export type WorkflowDryRunResponse = {
  success: boolean;
  steps: { nodeId: string; nodeType: string; success: boolean; output?: string }[];
};

/** Matches server OAuth provider registration (POST /api/v1/settings/oauth-providers). */
export type OAuthProviderConfigPayload = {
  id: string;
  provider: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
};

export type AuthProviderEntry = {
  id: string;
  provider: string;
  name: string;
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

  createWorkflow: (data: { serviceId: string; nodes: WorkflowGraphNode[]; edges: { from: string; to: string }[] }) =>
    apiFetch<WorkflowGraph>("/api/v1/workflows", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  executeWorkflow: (data: { serviceId: string; nodes: WorkflowGraphNode[]; edges: { from: string; to: string }[] }) =>
    apiFetch<WorkflowExecutionResponse>("/api/v1/workflows/execute", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  dryRunWorkflow: (data: { serviceId: string; nodes: WorkflowGraphNode[]; edges: { from: string; to: string }[] }) =>
    apiFetch<WorkflowDryRunResponse>("/api/v1/workflows/dry-run", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  listWorkflows: () => apiFetch<{ graphs: WorkflowGraph[] }>("/api/v1/workflows"),
  setServiceWorkflow: (serviceId: string, workflowGraphId: string | null) =>
    apiFetch<MonitoredService>(`/api/v1/services/${serviceId}/workflow`, {
      method: "PATCH",
      body: JSON.stringify({ workflowGraphId })
    }),
  getSettings: () => apiFetch<Record<string, unknown>>("/api/v1/settings").catch(() => null),
  updateSettings: (data: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>("/api/v1/settings", {
      method: "POST",
      body: JSON.stringify(data)
    }),
  listEnrollmentTokens: () =>
    apiFetch<{
      tokens: {
        id: string;
        tenantId: string;
        expiresAt: string;
        createdBy: string;
        createdAt: string;
        usedAt: string | null;
        revokedAt: string | null;
        isActive: boolean;
      }[];
    }>("/api/v1/agents/enrollment-tokens"),

  createEnrollmentToken: (data: { ttlSeconds: number }) =>
    apiFetch<{
      id: string;
      tenantId: string;
      token: string;
      expiresAt: string;
      createdBy: string;
      createdAt: string;
      usedAt: string | null;
      revokedAt: string | null;
      isActive: boolean;
    }>("/api/v1/agents/enrollment-tokens", {
      method: "POST",
      body: JSON.stringify(data)
    }),
  deactivateEnrollmentToken: (tokenId: string) =>
    apiFetch<void>(`/api/v1/agents/enrollment-tokens/${encodeURIComponent(tokenId)}/deactivate`, {
      method: "POST"
    }),
  deleteEnrollmentToken: (tokenId: string) =>
    apiFetch<void>(`/api/v1/agents/enrollment-tokens/${encodeURIComponent(tokenId)}`, {
      method: "DELETE"
    }),

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

  getAuthProviders: () => apiFetch<{ providers: AuthProviderEntry[] }>("/api/v1/auth/providers"),

  createOAuthProvider: (payload: OAuthProviderConfigPayload) =>
    apiFetch<{ ok: boolean }>("/api/v1/settings/oauth-providers", {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  getOAuthAuthorizeUrl: (providerId: string) =>
    apiFetch<{ authorizeUrl: string }>(`/api/v1/auth/oauth/authorize?provider=${encodeURIComponent(providerId)}`),

  handleOAuthCallback: (code: string, state: string) =>
    apiFetch<{ token: string }>(`/api/v1/auth/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`),

  getSetupStatus: () =>
    apiFetch<{ setupRequired: boolean; version: string }>("/api/v1/setup/status"),

  testDatabase: (databaseUrl: string) =>
    apiFetch<{ ok: boolean }>("/api/v1/setup/test-database", {
      method: "POST",
      body: JSON.stringify({ databaseUrl }),
    }),

  testRedis: (redisUrl: string) =>
    apiFetch<{ ok: boolean }>("/api/v1/setup/test-redis", {
      method: "POST",
      body: JSON.stringify({ redisUrl }),
    }),

  getSetupTenants: (databaseUrl: string) =>
    apiFetch<{ tenants: { id: string; name: string }[] }>(
      `/api/v1/setup/tenants?databaseUrl=${encodeURIComponent(databaseUrl)}`
    ),

  completeSetup: (data: {
    databaseUrl: string;
    redisUrl: string;
    publicBaseUrl?: string;
    adminEmail: string;
    adminPassword: string;
    githubAppId?: string;
    githubAppPrivateKeyPem?: string;
    githubWebhookSecret?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    defaultWebhookTenantId?: string;
    kubernetesNamespace?: string;
  }) =>
    apiFetch<{ ok: boolean; tenantId: string; adminEmail: string }>("/api/v1/setup/complete", {
      method: "POST",
      body: JSON.stringify(data),
    }),
};
