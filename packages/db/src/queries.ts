import crypto from "node:crypto";

export type QueryFn = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export interface IncidentRow {
  id: string;
  tenantId: string;
  serviceId: string;
  fingerprint: string;
  message?: string;
  status: string;
  eventCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

function mapIncident(r: Record<string, unknown>): IncidentRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    serviceId: r.service_id as string,
    fingerprint: r.fingerprint as string,
    message: r.message as string | undefined,
    status: r.status as string,
    eventCount: Number(r.event_count ?? 1),
    firstSeenAt:
      r.first_seen_at instanceof Date
        ? r.first_seen_at.toISOString()
        : String(r.first_seen_at),
    lastSeenAt:
      r.last_seen_at instanceof Date
        ? r.last_seen_at.toISOString()
        : String(r.last_seen_at),
  };
}

export async function listIncidents(
  query: QueryFn,
  tenantId: string,
): Promise<IncidentRow[]> {
  const { rows } = await query(
    `SELECT * FROM incidents WHERE tenant_id = $1 ORDER BY last_seen_at DESC`,
    [tenantId],
  );
  return rows.map(mapIncident);
}

export async function getIncident(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<IncidentRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows.length > 0 ? mapIncident(rows[0]) : undefined;
}

export async function upsertIncident(
  query: QueryFn,
  tenantId: string,
  data: { serviceId: string; fingerprint: string; message?: string },
): Promise<IncidentRow> {
  const { rows: existing } = await query(
    `SELECT * FROM incidents
     WHERE tenant_id = $1 AND service_id = $2 AND fingerprint = $3
       AND status IN ('open', 'acknowledged')
     LIMIT 1`,
    [tenantId, data.serviceId, data.fingerprint],
  );

  if (existing.length > 0) {
    const { rows } = await query(
      `UPDATE incidents
       SET event_count = event_count + 1, last_seen_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [existing[0].id, tenantId],
    );
    return mapIncident(rows[0]);
  }

  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO incidents (id, tenant_id, service_id, fingerprint, message, status, event_count, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 'open', 1, now(), now())
     RETURNING *`,
    [id, tenantId, data.serviceId, data.fingerprint, data.message ?? null],
  );
  return mapIncident(rows[0]);
}

export async function updateIncidentStatus(
  query: QueryFn,
  tenantId: string,
  id: string,
  status: string,
): Promise<IncidentRow | undefined> {
  const { rows } = await query(
    `UPDATE incidents SET status = $1 WHERE tenant_id = $2 AND id = $3 RETURNING *`,
    [status, tenantId, id],
  );
  return rows.length > 0 ? mapIncident(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  tenantId: string;
  name: string | null;
  version: string | null;
  status: string;
  lastSeenAt: string | null;
  certFingerprint?: string | null;
  allowedCapabilities?: string[];
}

function mapAgent(r: Record<string, unknown>): AgentRow {
  const caps = r.allowed_capabilities;
  const allowedCapabilities = Array.isArray(caps)
    ? (caps as string[])
    : undefined;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name == null ? null : String(r.name),
    version: r.version == null ? null : String(r.version),
    status: r.status as string,
    lastSeenAt:
      r.last_seen_at == null
        ? null
        : r.last_seen_at instanceof Date
          ? r.last_seen_at.toISOString()
          : String(r.last_seen_at),
    certFingerprint:
      r.cert_fingerprint == null ? null : String(r.cert_fingerprint),
    allowedCapabilities,
  };
}

export async function listAgents(
  query: QueryFn,
  tenantId: string,
): Promise<AgentRow[]> {
  const { rows } = await query(
    `SELECT * FROM agents WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.map(mapAgent);
}

export async function getAgent(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<AgentRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM agents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows.length > 0 ? mapAgent(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Monitored Services
// ---------------------------------------------------------------------------

export interface ServiceRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  name: string;
  repo: string;
  branch: string;
  dockerImage?: string | null;
  composePath?: string | null;
}

function mapService(r: Record<string, unknown>): ServiceRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    agentId: (r.agent_id as string) ?? null,
    name: r.name as string,
    repo: r.repo as string,
    branch: r.branch as string,
    dockerImage: r.docker_image == null ? null : String(r.docker_image),
    composePath: r.compose_path == null ? null : String(r.compose_path),
  };
}

export async function listServices(
  query: QueryFn,
  tenantId: string,
): Promise<ServiceRow[]> {
  const { rows } = await query(
    `SELECT * FROM monitored_services WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.map(mapService);
}

export async function getService(
  query: QueryFn,
  tenantId: string,
  id: string
): Promise<ServiceRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM monitored_services WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (rows.length === 0) {
    return undefined;
  }
  return mapService(rows[0]);
}

export async function createService(
  query: QueryFn,
  tenantId: string,
  data: {
    name: string;
    repo: string;
    branch: string;
    agentId?: string | null;
    dockerImage?: string;
    composePath?: string;
  },
): Promise<ServiceRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO monitored_services (id, tenant_id, agent_id, name, repo, branch, docker_image, compose_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, tenantId, data.agentId ?? null, data.name, data.repo, data.branch, data.dockerImage ?? null, data.composePath ?? null],
  );
  return mapService(rows[0]);
}

// ---------------------------------------------------------------------------
// Workflow Graphs
// ---------------------------------------------------------------------------

export interface WorkflowGraphRow {
  id: string;
  tenantId: string;
  serviceId: string;
  version: number;
  nodes: unknown[];
  edges: unknown[];
  isActive: boolean;
}

function mapWorkflowGraph(r: Record<string, unknown>): WorkflowGraphRow {
  const graph =
    typeof r.graph_json === "string"
      ? JSON.parse(r.graph_json)
      : (r.graph_json as { nodes: unknown[]; edges: unknown[] });
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    serviceId: r.service_id as string,
    version: Number(r.version),
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
    isActive: Boolean(r.is_active),
  };
}

export async function listWorkflowGraphs(
  query: QueryFn,
  tenantId: string,
): Promise<WorkflowGraphRow[]> {
  const { rows } = await query(
    `SELECT * FROM workflow_graphs WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.map(mapWorkflowGraph);
}

export async function createWorkflowGraph(
  query: QueryFn,
  tenantId: string,
  data: { serviceId: string; nodes: unknown[]; edges: unknown[] },
): Promise<WorkflowGraphRow> {
  const { rows: versionRows } = await query(
    `SELECT COALESCE(MAX(version), 0) AS max_version
     FROM workflow_graphs
     WHERE tenant_id = $1 AND service_id = $2`,
    [tenantId, data.serviceId],
  );
  const nextVersion = Number(versionRows[0].max_version) + 1;

  const id = crypto.randomUUID();
  const graphJson = JSON.stringify({ nodes: data.nodes, edges: data.edges });
  const { rows } = await query(
    `INSERT INTO workflow_graphs (id, tenant_id, service_id, version, graph_json, is_active)
     VALUES ($1, $2, $3, $4, $5, false)
     RETURNING *`,
    [id, tenantId, data.serviceId, nextVersion, graphJson],
  );
  return mapWorkflowGraph(rows[0]);
}
