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
    data: { name?: string | null; allowedCapabilities?: string[] }
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
      agentId?: string | null;
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
      agentId?: string | null;
      dockerImage?: string;
      composePath?: string;
    }
  ): Promise<MonitoredService | undefined>;
  deleteService(tenantId: string, id: string): Promise<boolean>;
};

const incidents = new Map<string, Incident>();
const agents = new Map<string, Agent>();
const services = new Map<string, MonitoredService>();
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
        allowedCapabilities: existing?.allowedCapabilities ?? []
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
          data.allowedCapabilities === undefined ? a.allowedCapabilities : [...data.allowedCapabilities]
      };
      agents.set(agentId, next);
      return next;
    },

    async deleteAgent(tenantId, agentId) {
      const a = agents.get(agentId);
      if (!a || a.tenantId !== tenantId) return false;
      agents.delete(agentId);
      for (const [svcId, svc] of services.entries()) {
        if (svc.tenantId === tenantId && svc.agentId === agentId) {
          services.set(svcId, { ...svc, agentId: null });
        }
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
      return [...services.values()].filter((s) => s.tenantId === tenantId);
    },
    async getService(tenantId, id) {
      const svc = services.get(id);
      return svc && svc.tenantId === tenantId ? svc : undefined;
    },
    async createService(tenantId, data) {
      const svc: MonitoredService = {
        id: `svc-${uid()}`,
        tenantId,
        agentId: data.agentId ?? null,
        name: data.name,
        gitRepoUrl: data.gitRepoUrl,
        sshKeyId: data.sshKeyId ?? null,
        branch: data.branch,
        dockerImage: data.dockerImage ?? null,
        composePath: data.composePath ?? null
      };
      services.set(svc.id, svc);
      return svc;
    },
    async updateService(tenantId, id, patch) {
      const svc = services.get(id);
      if (!svc || svc.tenantId !== tenantId) return undefined;
      if (patch.name !== undefined) svc.name = patch.name;
      if (patch.gitRepoUrl !== undefined) svc.gitRepoUrl = patch.gitRepoUrl;
      if (patch.sshKeyId !== undefined) svc.sshKeyId = patch.sshKeyId;
      if (patch.branch !== undefined) svc.branch = patch.branch;
      if (patch.agentId !== undefined) svc.agentId = patch.agentId;
      if (patch.dockerImage !== undefined) svc.dockerImage = patch.dockerImage;
      if (patch.composePath !== undefined) svc.composePath = patch.composePath;
      return svc;
    },
    async deleteService(tenantId, id) {
      const svc = services.get(id);
      if (!svc || svc.tenantId !== tenantId) return false;
      services.delete(id);
      return true;
    }
  };
}

export function __resetDomainStoreForTests(): void {
  incidents.clear();
  agents.clear();
  services.clear();
  sshKeys.clear();
  sshKeyPrivateMaterial.clear();
}

/** Seeds the in-memory agents map (Vitest / domain API tests only). */
export function __seedAgentForTests(agent: Agent): void {
  agents.set(agent.id, agent);
}
