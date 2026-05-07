import type { CreateTenantRequest, MeResponse, TenantSettings, SshKey, CreateSshKeyRequest } from "@sm/contracts";
export type { SshKey, CreateSshKeyRequest, CreateTenantRequest, MeResponse, TenantSettings };
import type { AuthUser } from "./useAuth.js";

/** Maps `/api/v1/me` JSON to `AuthUser` for React context. */
export function meResponseToAuthUser(m: MeResponse): AuthUser {
  const incomingMemberships = Array.isArray((m as { memberships?: unknown }).memberships)
    ? (m as { memberships: Array<{ tenantId: string; tenantName: string; role: AuthUser["role"] }> }).memberships
    : [];
  const memberships =
    incomingMemberships.length > 0
      ? incomingMemberships.map((row) => ({
          tenantId: row.tenantId,
          tenantName: row.tenantName,
          role: row.role
        }))
      : [
          {
            tenantId: m.tenantId,
            tenantName: m.tenantId,
            role: m.role
          }
        ];

  return {
    id: m.id,
    email: m.email,
    role: m.role,
    tenantId: m.tenantId,
    memberships
  };
}


const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:3001" : "");

function getAuthToken(): string {
  return localStorage.getItem("sm_token") ?? import.meta.env.VITE_AUTH_TOKEN ?? "dev-token";
}

/** GET /api/v1/settings — returns null when no row exists (404), throws on other errors. */
export async function getTenantSettings(): Promise<TenantSettings | null> {
  const res = await fetch(`${API_BASE}/api/v1/settings`, {
    headers: {
      Authorization: `Bearer ${getAuthToken()}`
    }
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
    throw new Error(body.message ?? `API ${res.status}`);
  }
  return res.json() as Promise<TenantSettings>;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null && init.body !== "";
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
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
  /** Present when API merges RealtimeManager session state. */
  websocketConnected?: boolean;
};

export type MonitoredService = {
  id: string;
  tenantId: string;
  name: string;
  gitRepoUrl: string;
  sshKeyId?: string | null;
  branch: string;
  agentId: string | null;
  dockerImage?: string | null;
  composePath?: string | null;
  agentRuntimeBackend?: string | null;
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

  me: () => apiFetch<MeResponse>("/api/v1/me"),

  switchActiveTenant: (tenantId: string) =>
    apiFetch<MeResponse>("/api/v1/session/active-tenant", {
      method: "POST",
      body: JSON.stringify({ tenantId })
    }),

  createTenant: (body: CreateTenantRequest) =>
    apiFetch<MeResponse>("/api/v1/tenants", {
      method: "POST",
      body: JSON.stringify(body)
    }),

  deleteTenant: (tenantId: string) =>
    apiFetch<void>(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
      method: "DELETE"
    }),

  listSshKeys: () => apiFetch<{ keys: SshKey[] }>("/api/v1/ssh-keys"),
  createSshKey: (body: CreateSshKeyRequest) =>
    apiFetch<SshKey>("/api/v1/ssh-keys", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  deleteSshKey: (id: string) =>
    apiFetch<void>(`/api/v1/ssh-keys/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  listIncidents: () => apiFetch<{ incidents: Incident[] }>("/api/v1/incidents"),
  updateIncidentStatus: (id: string, status: string) =>
    apiFetch<Incident>(`/api/v1/incidents/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }),
  listAgents: () => apiFetch<{ agents: Agent[] }>("/api/v1/agents"),
  getAgent: (id: string) =>
    apiFetch<Agent>(`/api/v1/agents/${encodeURIComponent(id)}`),
  updateAgent: (id: string, data: { name?: string | null; allowedCapabilities?: string[] }) =>
    apiFetch<Agent>(`/api/v1/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),
  deleteAgent: (id: string) =>
    apiFetch<void>(`/api/v1/agents/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  listServices: () => apiFetch<{ services: MonitoredService[] }>("/api/v1/services"),
  createService: (data: {
    name: string;
    gitRepoUrl: string;
    sshKeyId?: string;
    branch: string;
    dockerImage?: string;
    composePath?: string;
    agentRuntimeBackend?: string;
  }) =>
    apiFetch<MonitoredService>("/api/v1/services", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  updateService: (id: string, data: {
    name?: string;
    gitRepoUrl?: string;
    sshKeyId?: string | null;
    branch?: string;
    dockerImage?: string;
    composePath?: string;
    agentRuntimeBackend?: string;
  }) =>
    apiFetch<MonitoredService>(`/api/v1/services/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  getSettings: () => getTenantSettings(),
  updateSettings: (data: TenantSettings) =>
    apiFetch<TenantSettings>("/api/v1/settings", {
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

  /** Repositories visible to this tenant's linked GitHub App installation (GitHub REST). */
  listGithubInstallationRepos: () =>
    apiFetch<{ repos: string[] }>("/api/v1/github/installation-repositories"),

  getAuthProviders: () => apiFetch<{ providers: AuthProviderEntry[] }>("/api/v1/auth/providers"),

  createOAuthProvider: (payload: OAuthProviderConfigPayload) =>
    apiFetch<{ ok: boolean }>("/api/v1/settings/oauth-providers", {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  getGithubAppSettings: () =>
    apiFetch<{
      appId: string | null;
      appSlug: string | null;
      /** Ready-to-open GitHub install URL when the server could resolve the app slug. */
      installUrl: string | null;
      privateKeyConfigured: boolean;
      webhookSecretConfigured: boolean;
    }>("/api/v1/settings/github-app"),

  updateGithubAppSettings: (payload: {
    githubAppId: string;
    githubAppSlug?: string;
    githubAppPrivateKeyPem?: string;
    githubWebhookSecret?: string;
  }) =>
    apiFetch<{ ok: boolean }>("/api/v1/settings/github-app", {
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
