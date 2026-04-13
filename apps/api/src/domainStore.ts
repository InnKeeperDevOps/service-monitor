import crypto from "node:crypto";
import type {
  Agent,
  Incident,
  IncidentStatus,
  MonitoredService,
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphEdge,
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
      agentRuntimeBackend?: string;
    }
  ): Promise<MonitoredService>;
  updateServiceWorkflow(
    tenantId: string,
    serviceId: string,
    workflowGraphId: string | null
  ): Promise<MonitoredService | undefined>;
  deleteService(tenantId: string, id: string): Promise<boolean>;

  listWorkflowGraphs(tenantId: string): Promise<WorkflowGraph[]>;
  getWorkflowGraph(tenantId: string, workflowId: string): Promise<WorkflowGraph | undefined>;
  createWorkflowGraph(tenantId: string, data: { name: string; nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[] }): Promise<WorkflowGraph>;
};

const incidents = new Map<string, Incident>();
const agents = new Map<string, Agent>();
const services = new Map<string, MonitoredService>();
const workflows = new Map<string, WorkflowGraph>();
const sshKeys = new Map<string, SshKey>();

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
      return key;
    },
    async deleteSshKey(tenantId, id) {
      const key = sshKeys.get(id);
      if (!key || key.tenantId !== tenantId) return false;
      sshKeys.delete(id);
      return true;
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
        workflowGraphId: null,
        name: data.name,
        gitRepoUrl: data.gitRepoUrl,
        sshKeyId: data.sshKeyId ?? null,
        branch: data.branch,
        dockerImage: data.dockerImage ?? null,
        composePath: data.composePath ?? null,
        agentRuntimeBackend: data.agentRuntimeBackend
      };
      services.set(svc.id, svc);
      return svc;
    },
    async updateServiceWorkflow(tenantId, serviceId, workflowGraphId) {
      const svc = services.get(serviceId);
      if (!svc || svc.tenantId !== tenantId) return undefined;
      svc.workflowGraphId = workflowGraphId;
      return svc;
    },
    async deleteService(tenantId, id) {
      const svc = services.get(id);
      if (!svc || svc.tenantId !== tenantId) return false;
      services.delete(id);
      return true;
    },

    async listWorkflowGraphs(tenantId) {
      return [...workflows.values()].filter((w) => w.tenantId === tenantId);
    },
    async getWorkflowGraph(tenantId, workflowId) {
      const workflow = workflows.get(workflowId);
      if (!workflow || workflow.tenantId !== tenantId) return undefined;
      return workflow;
    },
    async createWorkflowGraph(tenantId, data) {
      const existing = [...workflows.values()].filter(
        (w) => w.tenantId === tenantId && w.name === data.name
      );
      const nextVersion = existing.length > 0 ? Math.max(...existing.map((w) => w.version)) + 1 : 1;
      const wg: WorkflowGraph = {
        id: `wf-${uid()}`,
        tenantId,
        name: data.name,
        version: nextVersion,
        nodes: data.nodes,
        edges: data.edges,
        isActive: false
      };
      workflows.set(wg.id, wg);
      return wg;
    }
  };
}

export function __resetDomainStoreForTests(): void {
  incidents.clear();
  agents.clear();
  services.clear();
  workflows.clear();
  sshKeys.clear();
}

/** Seeds the in-memory agents map (Vitest / domain API tests only). */
export function __seedAgentForTests(agent: Agent): void {
  agents.set(agent.id, agent);
}
