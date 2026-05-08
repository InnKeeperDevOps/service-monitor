import crypto from "node:crypto";

export type QueryFn = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface SshKeyRow {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  privateKeyEncrypted?: string | null;
  localPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSshKey(r: Record<string, unknown>): SshKeyRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    type: r.type as string,
    privateKeyEncrypted: r.private_key_encrypted == null ? null : String(r.private_key_encrypted),
    localPath: r.local_path == null ? null : String(r.local_path),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    updatedAt:
      r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : String(r.updated_at),
  };
}

export async function listSshKeys(
  query: QueryFn,
  tenantId: string,
): Promise<SshKeyRow[]> {
  const { rows } = await query(
    `SELECT * FROM ssh_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map(mapSshKey);
}

export async function getSshKey(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<SshKeyRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM ssh_keys WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows.length > 0 ? mapSshKey(rows[0]) : undefined;
}

export async function createSshKey(
  query: QueryFn,
  tenantId: string,
  data: {
    name: string;
    type: string;
    privateKeyEncrypted?: string | null;
    localPath?: string | null;
  },
): Promise<SshKeyRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO ssh_keys (id, tenant_id, name, type, private_key_encrypted, local_path)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, tenantId, data.name, data.type, data.privateKeyEncrypted ?? null, data.localPath ?? null],
  );
  return mapSshKey(rows[0]);
}

export async function deleteSshKey(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM ssh_keys WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, id],
  );
  return rows.length > 0;
}

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

/** Creates or updates a row when an agent sends realtime telemetry for this tenant. */
export async function recordAgentHeartbeat(
  query: QueryFn,
  tenantId: string,
  data: { agentId: string; version: string | null },
): Promise<void> {
  await query(
    `INSERT INTO agents (id, tenant_id, name, version, status, last_seen_at, cert_fingerprint, allowed_capabilities)
     VALUES ($1, $2, NULL, $3, 'online', NOW(), NULL, ARRAY[]::text[])
     ON CONFLICT (id) DO UPDATE SET
       version = COALESCE(EXCLUDED.version, agents.version),
       last_seen_at = NOW(),
       status = 'online'
     WHERE agents.tenant_id = EXCLUDED.tenant_id`,
    [data.agentId, tenantId, data.version],
  );
}

export async function markAgentOffline(query: QueryFn, tenantId: string, agentId: string): Promise<void> {
  await query(
    `UPDATE agents SET status = 'offline' WHERE id = $1 AND tenant_id = $2`,
    [agentId, tenantId],
  );
}

export async function updateAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  data: { name?: string | null; allowedCapabilities?: string[] }
): Promise<AgentRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [agentId, tenantId];
  if (data.name !== undefined) {
    params.push(data.name);
    sets.push(`name = $${params.length}`);
  }
  if (data.allowedCapabilities !== undefined) {
    params.push(data.allowedCapabilities);
    sets.push(`allowed_capabilities = $${params.length}`);
  }
  if (sets.length === 0) {
    const { rows } = await query(
      `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId]
    );
    return rows.length > 0 ? mapAgent(rows[0]) : undefined;
  }
  const { rows } = await query(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params
  );
  return rows.length > 0 ? mapAgent(rows[0]) : undefined;
}

export async function deleteAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM agents WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [agentId, tenantId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Monitored Services
// ---------------------------------------------------------------------------

export interface ServiceRow {
  id: string;
  tenantId: string;
  name: string;
  gitRepoUrl: string;
  sshKeyId: string | null;
  branch: string;
  dockerImage?: string | null;
  composePath?: string | null;
}

function mapService(r: Record<string, unknown>): ServiceRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    gitRepoUrl: r.git_repo_url as string,
    sshKeyId: (r.ssh_key_id as string) ?? null,
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
    gitRepoUrl: string;
    sshKeyId?: string | null;
    branch: string;
    dockerImage?: string;
    composePath?: string;
  },
): Promise<ServiceRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO monitored_services (id, tenant_id, name, git_repo_url, ssh_key_id, branch, docker_image, compose_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, tenantId, data.name, data.gitRepoUrl, data.sshKeyId ?? null, data.branch, data.dockerImage ?? null, data.composePath ?? null],
  );
  return mapService(rows[0]);
}

// ---------------------------------------------------------------------------
// agent_services join queries (many-to-many).
// ---------------------------------------------------------------------------

export interface AgentBindingRow {
  agentId: string;
}

export async function attachServiceToAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  serviceId: string
): Promise<boolean> {
  const { rows } = await query(
    `INSERT INTO agent_services (tenant_id, agent_id, service_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, service_id) DO NOTHING
     RETURNING agent_id`,
    [tenantId, agentId, serviceId]
  );
  return rows.length > 0;
}

export async function detachServiceFromAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  serviceId: string
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM agent_services
      WHERE tenant_id = $1 AND agent_id = $2 AND service_id = $3
     RETURNING agent_id`,
    [tenantId, agentId, serviceId]
  );
  return rows.length > 0;
}

export async function listAgentsForService(
  query: QueryFn,
  tenantId: string,
  serviceId: string
): Promise<AgentBindingRow[]> {
  const { rows } = await query(
    `SELECT agent_id FROM agent_services
      WHERE tenant_id = $1 AND service_id = $2
      ORDER BY created_at`,
    [tenantId, serviceId]
  );
  return rows.map((r) => ({ agentId: r.agent_id as string }));
}

export async function listServicesForAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<ServiceRow[]> {
  const { rows } = await query(
    `SELECT ms.* FROM monitored_services ms
       JOIN agent_services j ON j.service_id = ms.id
      WHERE j.tenant_id = $1 AND j.agent_id = $2
      ORDER BY j.created_at`,
    [tenantId, agentId]
  );
  return rows.map(mapService);
}

/**
 * setAgentBindings replaces the agent set for a service in one tx-friendly
 * pair of statements: delete bindings not in the desired set, then upsert the
 * remainder. Designed for `PATCH /api/v1/services/:id { agentIds }`.
 */
export async function setAgentBindings(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  agentIds: string[]
): Promise<void> {
  // Delete bindings whose agent_id is not in the desired list.
  if (agentIds.length === 0) {
    await query(
      `DELETE FROM agent_services WHERE tenant_id = $1 AND service_id = $2`,
      [tenantId, serviceId]
    );
    return;
  }
  await query(
    `DELETE FROM agent_services
      WHERE tenant_id = $1 AND service_id = $2 AND agent_id <> ALL($3::text[])`,
    [tenantId, serviceId, agentIds]
  );
  for (const agentId of agentIds) {
    await query(
      `INSERT INTO agent_services (tenant_id, agent_id, service_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenantId, agentId, serviceId]
    );
  }
}

export interface ApiCredentialRow {
  id: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function mapApiCredential(r: Record<string, unknown>): ApiCredentialRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    tokenHash: r.token_hash as string,
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
    createdAt: (r.created_at as Date | string).toString(),
    createdBy: (r.created_by as string | null) ?? null,
    lastUsedAt: r.last_used_at == null ? null : (r.last_used_at as Date | string).toString(),
    revokedAt: r.revoked_at == null ? null : (r.revoked_at as Date | string).toString(),
  };
}

export async function createApiCredential(
  query: QueryFn,
  data: { tenantId: string; name: string; tokenHash: string; scopes: string[]; createdBy?: string | null }
): Promise<ApiCredentialRow> {
  const id = `apicred-${crypto.randomUUID()}`;
  const { rows } = await query(
    `INSERT INTO api_credentials (id, tenant_id, name, token_hash, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, data.tenantId, data.name, data.tokenHash, data.scopes, data.createdBy ?? null]
  );
  return mapApiCredential(rows[0]);
}

export async function listApiCredentials(query: QueryFn, tenantId: string): Promise<ApiCredentialRow[]> {
  const { rows } = await query(
    `SELECT * FROM api_credentials WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows.map(mapApiCredential);
}

export async function findApiCredentialByTokenHash(
  query: QueryFn,
  tokenHash: string
): Promise<ApiCredentialRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM api_credentials WHERE token_hash = $1 LIMIT 1`,
    [tokenHash]
  );
  return rows.length === 0 ? undefined : mapApiCredential(rows[0]);
}

export async function revokeApiCredential(
  query: QueryFn,
  tenantId: string,
  id: string
): Promise<boolean> {
  const { rows } = await query(
    `UPDATE api_credentials SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, tenantId]
  );
  return rows.length > 0;
}

export async function touchApiCredentialLastUsed(
  query: QueryFn,
  id: string
): Promise<void> {
  await query(`UPDATE api_credentials SET last_used_at = now() WHERE id = $1`, [id]);
}
