import crypto from "node:crypto";
import type {
  Agent,
  Incident,
  IncidentStatus,
  MonitoredService,
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphEdge
} from "@sm/contracts";

export type DomainStore = {
  listIncidents(tenantId: string): Promise<Incident[]>;
  getIncident(tenantId: string, id: string): Promise<Incident | undefined>;
  upsertIncident(tenantId: string, data: { serviceId: string; fingerprint: string; message?: string }): Promise<Incident>;
  updateIncidentStatus(tenantId: string, id: string, status: IncidentStatus): Promise<Incident | undefined>;

  listAgents(tenantId: string): Promise<Agent[]>;
  getAgent(tenantId: string, id: string): Promise<Agent | undefined>;

  listServices(tenantId: string): Promise<MonitoredService[]>;
  getService(tenantId: string, id: string): Promise<MonitoredService | undefined>;
  createService(
    tenantId: string,
    data: {
      name: string;
      repo: string;
      branch: string;
      agentId?: string | null;
      dockerImage?: string;
      composePath?: string;
    }
  ): Promise<MonitoredService>;
  deleteService(tenantId: string, id: string): Promise<boolean>;

  listWorkflowGraphs(tenantId: string): Promise<WorkflowGraph[]>;
  createWorkflowGraph(tenantId: string, data: { serviceId: string; nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[] }): Promise<WorkflowGraph>;
};

const incidents = new Map<string, Incident>();
const agents = new Map<string, Agent>();
const services = new Map<string, MonitoredService>();
const workflows = new Map<string, WorkflowGraph>();

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
        repo: data.repo,
        branch: data.branch,
        dockerImage: data.dockerImage ?? null,
        composePath: data.composePath ?? null
      };
      services.set(svc.id, svc);
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
    async createWorkflowGraph(tenantId, data) {
      const existing = [...workflows.values()].filter(
        (w) => w.tenantId === tenantId && w.serviceId === data.serviceId
      );
      const nextVersion = existing.length > 0 ? Math.max(...existing.map((w) => w.version)) + 1 : 1;
      const wg: WorkflowGraph = {
        id: `wf-${uid()}`,
        tenantId,
        serviceId: data.serviceId,
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
}
