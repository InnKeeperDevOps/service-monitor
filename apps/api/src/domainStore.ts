import crypto from "node:crypto";
import type {
  Agent,
  Incident,
  IncidentStatus,
  MonitoredService,
  SshKey
} from "@sm/contracts";

export type DomainStore = {
  listIncidents(tenantId: string): Promise<Incident[]>;
  getIncident(tenantId: string, id: string): Promise<Incident | undefined>;
  upsertIncident(tenantId: string, data: { serviceId: string; fingerprint: string; message?: string }): Promise<Incident>;
  updateIncidentStatus(tenantId: string, id: string, status: IncidentStatus): Promise<Incident | undefined>;

  listAgents(tenantId: string): Promise<Agent[]>;
  getAgent(tenantId: string, id: string): Promise<Agent | undefined>;
  recordAgentHeartbeat(
    tenantId: string,
    data: { agentId: string; version: string | null },
  ): Promise<void>;
  markAgentOffline(tenantId: string, agentId: string): Promise<void>;
  /** Tenant-scoped administrative metadata update (rename, capability allow-list). */
  updateAgent(
    tenantId: string,
    agentId: string,
    data: { name?: string | null; allowedCapabilities?: string[]; environment?: string }
  ): Promise<Agent | undefined>;
  deleteAgent(tenantId: string, agentId: string): Promise<boolean>;

  listSshKeys(tenantId: string): Promise<SshKey[]>;
  createSshKey(
    tenantId: string,
    data: {
      name: string;
      type: "uploaded" | "local_path";
      privateKey?: string;
      localPath?: string;
    }
  ): Promise<SshKey>;
  deleteSshKey(tenantId: string, id: string): Promise<boolean>;
  /**
   * Fetch the actual key material (decrypted private key for `uploaded`,
   * or the local path for `local_path`). Returns null when the key is
   * missing or stored in a way the API cannot read.
   */
  getSshKeyMaterial(
    tenantId: string,
    id: string
  ): Promise<{ type: "uploaded" | "local_path"; privateKey: string | null; localPath: string | null } | null>;

  listServices(tenantId: string): Promise<MonitoredService[]>;
  getService(tenantId: string, id: string): Promise<MonitoredService | undefined>;
  createService(
    tenantId: string,
    data: {
      name: string;
      gitRepoUrl: string;
      sshKeyId?: string | null;
      branch: string;
      /** Initial agent bindings (many-to-many). Defaults to empty. */
      agentIds?: string[];
      dockerImage?: string;
      composePath?: string;
    }
  ): Promise<MonitoredService>;
  updateService(
    tenantId: string,
    id: string,
    patch: {
      name?: string;
      gitRepoUrl?: string;
      sshKeyId?: string | null;
      branch?: string;
      /**
       * When defined, replaces the full set of agent bindings (delete-not-in,
       * insert-missing). Omit to leave bindings unchanged. Pass `[]` to
       * detach all agents.
       */
      agentIds?: string[];
      dockerImage?: string;
      composePath?: string;
    }
  ): Promise<MonitoredService | undefined>;
  deleteService(tenantId: string, id: string): Promise<boolean>;

  // Many-to-many agent ↔ service binding helpers.
  attachServiceToAgent(tenantId: string, agentId: string, serviceId: string): Promise<boolean>;
  detachServiceFromAgent(tenantId: string, agentId: string, serviceId: string): Promise<boolean>;
  listServicesForAgent(tenantId: string, agentId: string): Promise<MonitoredService[]>;
};

const incidents = new Map<string, Incident>();
const agents = new Map<string, Agent>();
const services = new Map<string, MonitoredService>();
/**
 * Many-to-many agent ↔ service binding. Keyed by `${agentId}|${serviceId}`
 * to make membership checks O(1). Tenant-scoping is enforced at the call
 * site (every helper looks up the service or agent first to confirm
 * tenancy).
 */
const agentServiceBindings = new Set<string>();
function bindingKey(agentId: string, serviceId: string): string {
  return `${agentId}|${serviceId}`;
}
function bindingsForService(serviceId: string): { agentId: string }[] {
  const out: { agentId: string }[] = [];
  for (const k of agentServiceBindings) {
    const [a, s] = k.split("|");
    if (s === serviceId) out.push({ agentId: a });
  }
  return out;
}
function withAgents(svc: MonitoredService): MonitoredService {
  return { ...svc, agents: bindingsForService(svc.id) };
}
const sshKeys = new Map<string, SshKey>();
/** In-memory companion to `sshKeys`: holds the raw private key value (only
 *  populated when a caller created an `uploaded` key). The value is intentionally
 *  not on the SshKey type so it never leaks back through API responses. */
const sshKeyPrivateMaterial = new Map<string, string>();

function uid(): string {
  return crypto.randomUUID();
}

export function createMemoryDomainStore(): DomainStore {
  return {
    async listIncidents(tenantId) {
      return [...incidents.values()].filter((i) => i.tenantId === tenantId);
    },
    async getIncident(tenantId, id) {
      const inc = incidents.get(id);
      return inc && inc.tenantId === tenantId ? inc : undefined;
    },
    async upsertIncident(tenantId, data) {
      const existing = [...incidents.values()].find(
        (i) => i.tenantId === tenantId && i.serviceId === data.serviceId && i.fingerprint === data.fingerprint && (i.status === "open" || i.status === "acknowledged")
      );
      if (existing) {
        existing.lastSeenAt = new Date().toISOString();
        existing.eventCount = (existing.eventCount ?? 1) + 1;
        return existing;
      }
      const now = new Date().toISOString();
      const inc: Incident = {
        id: `inc-${uid()}`,
        tenantId,
        serviceId: data.serviceId,
        fingerprint: data.fingerprint,
        status: "open",
        message: data.message,
        firstSeenAt: now,
        lastSeenAt: now,
        eventCount: 1
      };
      incidents.set(inc.id, inc);
      return inc;
    },
    async updateIncidentStatus(tenantId, id, status) {
      const inc = incidents.get(id);
      if (!inc || inc.tenantId !== tenantId) return undefined;
      inc.status = status;
      return inc;
    },

    async listAgents(tenantId) {
      return [...agents.values()].filter((a) => a.tenantId === tenantId);
    },
    async getAgent(tenantId, id) {
      const a = agents.get(id);
      return a && a.tenantId === tenantId ? a : undefined;
    },

    async recordAgentHeartbeat(tenantId, data) {
      const existing = agents.get(data.agentId);
      if (existing && existing.tenantId !== tenantId) {
        return;
      }
      const now = new Date().toISOString();
      const next: Agent = {
        id: data.agentId,
        tenantId,
        name: existing?.name ?? null,
        version: data.version ?? existing?.version ?? null,
        status: "online",
        lastSeenAt: now,
        certFingerprint: existing?.certFingerprint ?? null,
        allowedCapabilities: existing?.allowedCapabilities ?? [],
        environment: existing?.environment ?? "development"
      };
      agents.set(data.agentId, next);
    },

    async markAgentOffline(tenantId, agentId) {
      const a = agents.get(agentId);
      if (!a || a.tenantId !== tenantId) return;
      agents.set(agentId, { ...a, status: "offline" });
    },

    async updateAgent(tenantId, agentId, data) {
      const a = agents.get(agentId);
      if (!a || a.tenantId !== tenantId) return undefined;
      const next: Agent = {
        ...a,
        name: data.name === undefined ? a.name : data.name,
        allowedCapabilities:
          data.allowedCapabilities === undefined ? a.allowedCapabilities : [...data.allowedCapabilities],
        environment: data.environment === undefined ? a.environment : data.environment
      };
      agents.set(agentId, next);
      return next;
    },

    async deleteAgent(tenantId, agentId) {
      const a = agents.get(agentId);
      if (!a || a.tenantId !== tenantId) return false;
      agents.delete(agentId);
      // Drop all bindings for this agent (postgres FK cascade does the
      // equivalent on that side).
      for (const k of [...agentServiceBindings]) {
        const [boundAgent] = k.split("|");
        if (boundAgent === agentId) agentServiceBindings.delete(k);
      }
      return true;
    },

    async listSshKeys(tenantId) {
      return [...sshKeys.values()].filter((k) => k.tenantId === tenantId);
    },
    async createSshKey(tenantId, data) {
      const now = new Date().toISOString();
      const key: SshKey = {
        id: `key-${uid()}`,
        tenantId,
        name: data.name,
        type: data.type as "uploaded" | "local_path",
        localPath: data.localPath ?? null,
        createdAt: now,
        updatedAt: now
      };
      sshKeys.set(key.id, key);
      if (data.type === "uploaded" && data.privateKey) {
        sshKeyPrivateMaterial.set(key.id, data.privateKey);
      }
      return key;
    },
    async deleteSshKey(tenantId, id) {
      const key = sshKeys.get(id);
      if (!key || key.tenantId !== tenantId) return false;
      sshKeys.delete(id);
      sshKeyPrivateMaterial.delete(id);
      return true;
    },
    async getSshKeyMaterial(tenantId, id) {
      const key = sshKeys.get(id);
      if (!key || key.tenantId !== tenantId) return null;
      if (key.type === "uploaded") {
        const pk = sshKeyPrivateMaterial.get(id);
        return { type: "uploaded", privateKey: pk ?? null, localPath: null };
      }
      return { type: "local_path", privateKey: null, localPath: key.localPath ?? null };
    },

    async listServices(tenantId) {
      return [...services.values()]
        .filter((s) => s.tenantId === tenantId)
        .map(withAgents);
    },
    async getService(tenantId, id) {
      const svc = services.get(id);
      if (!svc || svc.tenantId !== tenantId) return undefined;
      return withAgents(svc);
    },
    async createService(tenantId, data) {
      const svc: MonitoredService = {
        id: `svc-${uid()}`,
        tenantId,
        name: data.name,
        gitRepoUrl: data.gitRepoUrl,
        sshKeyId: data.sshKeyId ?? null,
        branch: data.branch,
        dockerImage: data.dockerImage ?? null,
        composePath: data.composePath ?? null,
        agents: []
      };
      services.set(svc.id, svc);
      for (const agentId of data.agentIds ?? []) {
        agentServiceBindings.add(bindingKey(agentId, svc.id));
      }
      return withAgents(svc);
    },
    async updateService(tenantId, id, patch) {
      const svc = services.get(id);
      if (!svc || svc.tenantId !== tenantId) return undefined;
      if (patch.name !== undefined) svc.name = patch.name;
      if (patch.gitRepoUrl !== undefined) svc.gitRepoUrl = patch.gitRepoUrl;
      if (patch.sshKeyId !== undefined) svc.sshKeyId = patch.sshKeyId;
      if (patch.branch !== undefined) svc.branch = patch.branch;
      if (patch.dockerImage !== undefined) svc.dockerImage = patch.dockerImage;
      if (patch.composePath !== undefined) svc.composePath = patch.composePath;
      if (patch.agentIds !== undefined) {
        // Replace the full set: drop bindings for this service that aren't in the
        // desired list, then add any missing ones.
        const desired = new Set(patch.agentIds);
        for (const k of [...agentServiceBindings]) {
          const [a, s] = k.split("|");
          if (s === id && !desired.has(a)) agentServiceBindings.delete(k);
        }
        for (const a of patch.agentIds) {
          agentServiceBindings.add(bindingKey(a, id));
        }
      }
      return withAgents(svc);
    },
    async deleteService(tenantId, id) {
      const svc = services.get(id);
      if (!svc || svc.tenantId !== tenantId) return false;
      services.delete(id);
      // Garbage-collect bindings (the postgres FK does this automatically).
      for (const k of [...agentServiceBindings]) {
        const [, s] = k.split("|");
        if (s === id) agentServiceBindings.delete(k);
      }
      return true;
    },

    async attachServiceToAgent(tenantId, agentId, serviceId) {
      const svc = services.get(serviceId);
      if (!svc || svc.tenantId !== tenantId) return false;
      const k = bindingKey(agentId, serviceId);
      if (agentServiceBindings.has(k)) return false; // Already bound — caller infers idempotency.
      agentServiceBindings.add(k);
      return true;
    },
    async detachServiceFromAgent(tenantId, agentId, serviceId) {
      const svc = services.get(serviceId);
      if (!svc || svc.tenantId !== tenantId) return false;
      return agentServiceBindings.delete(bindingKey(agentId, serviceId));
    },
    async listServicesForAgent(tenantId, agentId) {
      const ids: string[] = [];
      for (const k of agentServiceBindings) {
        const [a, s] = k.split("|");
        if (a === agentId) ids.push(s);
      }
      const out: MonitoredService[] = [];
      for (const id of ids) {
        const svc = services.get(id);
        if (svc && svc.tenantId === tenantId) out.push(withAgents(svc));
      }
      return out;
    }
  };
}

export function __resetDomainStoreForTests(): void {
  incidents.clear();
  agents.clear();
  services.clear();
  agentServiceBindings.clear();
  sshKeys.clear();
  sshKeyPrivateMaterial.clear();
}

/** Seeds the in-memory agents map (Vitest / domain API tests only). */
export function __seedAgentForTests(agent: Agent): void {
  agents.set(agent.id, agent);
}
