import type { Pool } from "pg";
import type { DomainStore } from "./domainStore.js";
import * as queries from "@sm/db";

export function createPostgresDomainStore(pool: Pool): DomainStore {
  const queryFn = async (sql: string, params: unknown[]) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };

  return {
    listIncidents: (tenantId) => queries.listIncidents(queryFn, tenantId),
    getIncident: (tenantId, id) => queries.getIncident(queryFn, tenantId, id),
    upsertIncident: (tenantId, data) => queries.upsertIncident(queryFn, tenantId, data),
    updateIncidentStatus: (tenantId, id, status) =>
      queries.updateIncidentStatus(queryFn, tenantId, id, status),
    listAgents: (tenantId) => queries.listAgents(queryFn, tenantId),
    getAgent: (tenantId, id) => queries.getAgent(queryFn, tenantId, id),
    listServices: (tenantId) => queries.listServices(queryFn, tenantId),
    getService: (tenantId, id) => queries.getService(queryFn, tenantId, id),
    createService: (tenantId, data) => queries.createService(queryFn, tenantId, data),
    deleteService: async (tenantId, id) => {
      const { rows } = await queryFn(
        "DELETE FROM monitored_services WHERE id = $1 AND tenant_id = $2 RETURNING id",
        [id, tenantId]
      );
      return rows.length > 0;
    },
    listWorkflowGraphs: (tenantId) => queries.listWorkflowGraphs(queryFn, tenantId),
    createWorkflowGraph: (tenantId, data) => queries.createWorkflowGraph(queryFn, tenantId, data)
  } as DomainStore;
}
