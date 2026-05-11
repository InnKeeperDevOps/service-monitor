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
  /** Deployment environment this agent serves (e.g. 'development', 'production'). */
  environment: string;
  /**
   * Runtime backend the agent reports it has configured itself for
   * ("docker" | "kubernetes" | "shell"). Null until the first
   * runtime-aware heartbeat arrives, so the UI can show "unknown"
   * for legacy agents that haven't been upgraded.
   */
  runtimeBackend: string | null;
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
    environment: String(r.environment ?? "development"),
    runtimeBackend: r.runtime_backend == null ? null : String(r.runtime_backend),
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
  data: { agentId: string; version: string | null; runtimeBackend?: string | null },
): Promise<void> {
  await query(
    `INSERT INTO agents (id, tenant_id, name, version, status, last_seen_at, cert_fingerprint, allowed_capabilities, runtime_backend)
     VALUES ($1, $2, NULL, $3, 'online', NOW(), NULL, ARRAY[]::text[], $4)
     ON CONFLICT (id) DO UPDATE SET
       version = COALESCE(EXCLUDED.version, agents.version),
       last_seen_at = NOW(),
       status = 'online',
       runtime_backend = COALESCE(EXCLUDED.runtime_backend, agents.runtime_backend)
     WHERE agents.tenant_id = EXCLUDED.tenant_id`,
    [data.agentId, tenantId, data.version, data.runtimeBackend ?? null],
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
  data: { name?: string | null; allowedCapabilities?: string[]; environment?: string }
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
  if (data.environment !== undefined) {
    params.push(data.environment);
    sets.push(`environment = $${params.length}`);
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
  pipelineName?: string | null;
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
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name),
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
    pipelineName?: string | null;
  },
): Promise<ServiceRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO monitored_services (id, tenant_id, name, git_repo_url, ssh_key_id, branch, docker_image, compose_path, pipeline_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [id, tenantId, data.name, data.gitRepoUrl, data.sshKeyId ?? null, data.branch, data.dockerImage ?? null, data.composePath ?? null, data.pipelineName ?? null],
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

// ---------------------------------------------------------------------------
// Build pipeline (service_builds, service_build_artifacts)
// ---------------------------------------------------------------------------

export type BuildStatus = "queued" | "running" | "success" | "failed" | "no_pipeline";
export type BuildTrigger = "poll" | "manual";

export interface ServiceBuildRow {
  id: string;
  tenantId: string;
  serviceId: string;
  /** Empty string for manual builds whose SHA hasn't been resolved yet. */
  gitSha: string;
  branch: string;
  status: BuildStatus;
  triggeredBy: BuildTrigger;
  imageRef: string | null;
  log: string;
  pipelineYaml: string | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ServiceBuildArtifactRow {
  buildId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  relPath: string;
  createdAt: string;
}

function mapBuild(r: Record<string, unknown>): ServiceBuildRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    serviceId: String(r.service_id),
    gitSha: String(r.git_sha ?? ""),
    branch: String(r.branch),
    status: String(r.status) as BuildStatus,
    triggeredBy: (String(r.triggered_by ?? "poll") as BuildTrigger),
    imageRef: r.image_ref == null ? null : String(r.image_ref),
    log: String(r.log ?? ""),
    pipelineYaml: r.pipeline_yaml == null ? null : String(r.pipeline_yaml),
    failureReason: r.failure_reason == null ? null : String(r.failure_reason),
    createdAt: new Date(r.created_at as string).toISOString(),
    startedAt: r.started_at == null ? null : new Date(r.started_at as string).toISOString(),
    finishedAt: r.finished_at == null ? null : new Date(r.finished_at as string).toISOString()
  };
}

function mapArtifact(r: Record<string, unknown>): ServiceBuildArtifactRow {
  return {
    buildId: String(r.build_id),
    name: String(r.name),
    sizeBytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    relPath: String(r.rel_path),
    createdAt: new Date(r.created_at as string).toISOString()
  };
}

/**
 * Insert a queued build for the periodic poller. Caller must already have
 * verified via getLatestBuildSha that this SHA hasn't been polled yet —
 * the DB no longer enforces a unique index on (service_id, git_sha) since
 * manual rebuilds at the same SHA are now legal.
 */
export async function enqueueBuild(
  query: QueryFn,
  data: {
    tenantId: string;
    serviceId: string;
    gitSha: string;
    branch: string;
  }
): Promise<ServiceBuildRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO service_builds (id, tenant_id, service_id, git_sha, branch, status, triggered_by)
     VALUES ($1, $2, $3, $4, $5, 'queued', 'poll')
     RETURNING *`,
    [id, data.tenantId, data.serviceId, data.gitSha, data.branch]
  );
  return mapBuild(rows[0]);
}

/**
 * Insert a queued MANUAL build. The SHA is left empty; the worker
 * resolves HEAD via git ls-remote on claim and writes it back via
 * updateBuildGitSha before running the actual build. Manual builds
 * also dispatch a redeploy_service agent command on success.
 */
export async function enqueueManualBuild(
  query: QueryFn,
  data: {
    tenantId: string;
    serviceId: string;
    branch: string;
  }
): Promise<ServiceBuildRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO service_builds (id, tenant_id, service_id, git_sha, branch, status, triggered_by)
     VALUES ($1, $2, $3, '', $4, 'queued', 'manual')
     RETURNING *`,
    [id, data.tenantId, data.serviceId, data.branch]
  );
  return mapBuild(rows[0]);
}

/** Persist a SHA the worker resolved post-claim for a manual build. */
export async function updateBuildGitSha(
  query: QueryFn,
  buildId: string,
  gitSha: string
): Promise<void> {
  await query(`UPDATE service_builds SET git_sha = $2 WHERE id = $1`, [buildId, gitSha]);
}

/**
 * Atomically claim the next queued build (FIFO by created_at). Sets
 * status='running' and started_at=now() in the same UPDATE so two
 * builders racing for the same row get exactly one winner.
 */
export async function claimNextBuild(query: QueryFn): Promise<ServiceBuildRow | null> {
  const { rows } = await query(
    `UPDATE service_builds
        SET status = 'running', started_at = now()
      WHERE id = (
        SELECT id FROM service_builds
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    []
  );
  return rows.length === 0 ? null : mapBuild(rows[0]);
}

export async function appendBuildLog(
  query: QueryFn,
  buildId: string,
  chunk: string
): Promise<void> {
  if (chunk.length === 0) return;
  await query(`UPDATE service_builds SET log = log || $2 WHERE id = $1`, [buildId, chunk]);
}

export async function setBuildPipelineYaml(
  query: QueryFn,
  buildId: string,
  yamlText: string
): Promise<void> {
  await query(`UPDATE service_builds SET pipeline_yaml = $2 WHERE id = $1`, [buildId, yamlText]);
}

export async function finishBuild(
  query: QueryFn,
  buildId: string,
  data: { status: BuildStatus; imageRef?: string | null; failureReason?: string | null }
): Promise<void> {
  await query(
    `UPDATE service_builds
        SET status = $2,
            image_ref = COALESCE($3, image_ref),
            failure_reason = COALESCE($4, failure_reason),
            finished_at = now()
      WHERE id = $1`,
    [buildId, data.status, data.imageRef ?? null, data.failureReason ?? null]
  );
}

export async function listBuildsForService(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  limit = 50
): Promise<ServiceBuildRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_builds
      WHERE tenant_id = $1 AND service_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, serviceId, limit]
  );
  return rows.map(mapBuild);
}

export async function getBuild(
  query: QueryFn,
  tenantId: string,
  buildId: string
): Promise<ServiceBuildRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM service_builds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, buildId]
  );
  return rows.length === 0 ? undefined : mapBuild(rows[0]);
}

/**
 * Returns the most recent SHA the POLLER has enqueued for this service
 * (any status — the poller treats success, failure, and no_pipeline
 * identically: SHA seen, don't re-enqueue). Filtered to poll-triggered
 * builds so manual rebuilds don't make the poller think it's caught up.
 * Empty SHAs (in-flight manual builds) are skipped too.
 */
export async function getLatestBuildSha(
  query: QueryFn,
  serviceId: string
): Promise<string | null> {
  const { rows } = await query(
    `SELECT git_sha FROM service_builds
      WHERE service_id = $1
        AND triggered_by = 'poll'
        AND git_sha <> ''
      ORDER BY created_at DESC
      LIMIT 1`,
    [serviceId]
  );
  return rows.length === 0 ? null : String(rows[0].git_sha);
}

export async function listAllServicesForPoller(
  query: QueryFn
): Promise<
  Array<{
    id: string;
    tenantId: string;
    name: string;
    gitRepoUrl: string;
    sshKeyId: string | null;
    branch: string;
    pipelineName: string | null;
    kind: string;
    dependsOn: string[];
  }>
> {
  const { rows } = await query(
    `SELECT id, tenant_id, name, git_repo_url, ssh_key_id, branch, pipeline_name, kind, depends_on
       FROM monitored_services`,
    []
  );
  return rows.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    gitRepoUrl: String(r.git_repo_url),
    sshKeyId: r.ssh_key_id == null ? null : String(r.ssh_key_id),
    branch: String(r.branch),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name),
    kind: r.kind == null ? "deployable" : String(r.kind),
    dependsOn: Array.isArray(r.depends_on) ? (r.depends_on as unknown[]).map((v) => String(v)) : []
  }));
}

/**
 * Cache the service's kind + dependsOn from its latest kaiad.yaml so
 * cheap reverse-lookups (find services that depend on X) and policy
 * gates (skip deploy when kind=supporting) don't need to re-parse
 * every build's pipeline_yaml.
 */
export async function updateServicePipelineMeta(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  data: { kind: string; dependsOn: string[] }
): Promise<void> {
  await query(
    `UPDATE monitored_services
        SET kind        = $3,
            depends_on  = $4::text[]
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, serviceId, data.kind, data.dependsOn]
  );
}

/**
 * Reverse lookup: find every service whose dependsOn array contains
 * `depName`. Used post-build to chain-trigger dependents.
 */
export async function listServicesDependingOn(
  query: QueryFn,
  tenantId: string,
  depName: string
): Promise<Array<{ id: string; name: string; branch: string }>> {
  const { rows } = await query(
    `SELECT id, name, branch
       FROM monitored_services
      WHERE tenant_id = $1
        AND depends_on @> ARRAY[$2]::text[]`,
    [tenantId, depName]
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    branch: String(r.branch)
  }));
}

/**
 * Latest successful build for a service (by tenant + service name).
 * Used at dep resolution time to pick the image_ref + sha that the
 * dependent service's build templates should interpolate.
 */
export async function getLatestSuccessfulBuildByServiceName(
  query: QueryFn,
  tenantId: string,
  serviceName: string
): Promise<{ buildId: string; serviceId: string; gitSha: string; imageRef: string | null } | null> {
  const { rows } = await query(
    `SELECT b.id, b.service_id, b.git_sha, b.image_ref
       FROM service_builds b
       JOIN monitored_services s ON s.id = b.service_id
      WHERE b.tenant_id = $1
        AND s.name      = $2
        AND b.status    = 'success'
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [tenantId, serviceName]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    buildId: String(r.id),
    serviceId: String(r.service_id),
    gitSha: String(r.git_sha),
    imageRef: r.image_ref == null ? null : String(r.image_ref)
  };
}

export async function recordBuildArtifact(
  query: QueryFn,
  data: {
    buildId: string;
    name: string;
    sizeBytes: number;
    sha256: string;
    relPath: string;
  }
): Promise<void> {
  await query(
    `INSERT INTO service_build_artifacts (build_id, name, size_bytes, sha256, rel_path)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (build_id, name) DO UPDATE
       SET size_bytes = EXCLUDED.size_bytes,
           sha256 = EXCLUDED.sha256,
           rel_path = EXCLUDED.rel_path`,
    [data.buildId, data.name, data.sizeBytes, data.sha256, data.relPath]
  );
}

export async function listBuildArtifacts(
  query: QueryFn,
  buildId: string
): Promise<ServiceBuildArtifactRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_build_artifacts WHERE build_id = $1 ORDER BY name`,
    [buildId]
  );
  return rows.map(mapArtifact);
}

// ---------------------------------------------------------------------------
// Load balancer / ingress status (one row per service+environment, upserted
// by the agent after a successful redeploy_service)
// ---------------------------------------------------------------------------

export type LoadBalancerType = "none" | "k8s" | "metallb" | "nginx";

export interface LoadBalancerStatusRow {
  id: string;
  tenantId: string;
  serviceId: string;
  agentId: string | null;
  environment: string;
  namespace: string;
  lbType: LoadBalancerType;
  externalIp: string | null;
  externalHostname: string | null;
  ports: Array<{ port: number; name?: string; protocol?: string; targetPort?: number }>;
  domains: Array<{ host: string; port: number; protocol: "http" | "https" }>;
  detail: Record<string, unknown>;
  /** Fully-qualified image reference the agent applied. */
  imageRef: string | null;
  /** Source build row id, if known. Lets the panel link the running version to its build log. */
  buildId: string | null;
  observedAt: string;
}

function mapLb(r: Record<string, unknown>): LoadBalancerStatusRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    serviceId: String(r.service_id),
    agentId: r.agent_id == null ? null : String(r.agent_id),
    environment: String(r.environment),
    namespace: String(r.namespace ?? ""),
    lbType: String(r.lb_type) as LoadBalancerType,
    externalIp: r.external_ip == null ? null : String(r.external_ip),
    externalHostname: r.external_hostname == null ? null : String(r.external_hostname),
    ports: Array.isArray(r.ports) ? (r.ports as LoadBalancerStatusRow["ports"]) : [],
    domains: Array.isArray(r.domains) ? (r.domains as LoadBalancerStatusRow["domains"]) : [],
    detail: typeof r.detail === "object" && r.detail !== null
      ? (r.detail as Record<string, unknown>)
      : {},
    imageRef: r.image_ref == null ? null : String(r.image_ref),
    buildId: r.build_id == null ? null : String(r.build_id),
    observedAt: new Date(r.observed_at as string).toISOString()
  };
}

export async function upsertLoadBalancerStatus(
  query: QueryFn,
  data: {
    tenantId: string;
    serviceId: string;
    agentId: string | null;
    environment: string;
    namespace: string;
    lbType: LoadBalancerType;
    externalIp: string | null;
    externalHostname: string | null;
    ports: LoadBalancerStatusRow["ports"];
    domains: LoadBalancerStatusRow["domains"];
    detail: Record<string, unknown>;
    imageRef: string | null;
    buildId: string | null;
  }
): Promise<LoadBalancerStatusRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO service_loadbalancer_status
       (id, tenant_id, service_id, agent_id, environment, namespace, lb_type,
        external_ip, external_hostname, ports, domains, detail,
        image_ref, build_id, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, now())
     ON CONFLICT (service_id, environment) DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       namespace = EXCLUDED.namespace,
       lb_type = EXCLUDED.lb_type,
       external_ip = EXCLUDED.external_ip,
       external_hostname = EXCLUDED.external_hostname,
       ports = EXCLUDED.ports,
       domains = EXCLUDED.domains,
       detail = EXCLUDED.detail,
       image_ref = EXCLUDED.image_ref,
       build_id = EXCLUDED.build_id,
       observed_at = now()
     RETURNING *`,
    [
      id,
      data.tenantId,
      data.serviceId,
      data.agentId,
      data.environment,
      data.namespace,
      data.lbType,
      data.externalIp,
      data.externalHostname,
      JSON.stringify(data.ports),
      JSON.stringify(data.domains),
      JSON.stringify(data.detail),
      data.imageRef,
      data.buildId
    ]
  );
  return mapLb(rows[0]);
}

/**
 * Returns the latest reported state for every service this agent is
 * known to be running. Used by the Agents page to show "what version
 * of each service is on this agent". One row per (service_id) — the
 * agent is the source of truth for any service it's bound to.
 */
export async function listRunningServicesForAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<LoadBalancerStatusRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_loadbalancer_status
      WHERE tenant_id = $1 AND agent_id = $2
      ORDER BY observed_at DESC`,
    [tenantId, agentId]
  );
  return rows.map(mapLb);
}

/**
 * Look up + delete the lb_status_report row for one (service, agent)
 * pair. Returns the row that was deleted (so the caller has the last
 * known namespace/env to send in the teardown_service command), or
 * null if nothing was tracked.
 */
export async function popLoadBalancerStatusForAgentService(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  serviceId: string
): Promise<LoadBalancerStatusRow | null> {
  const { rows } = await query(
    `DELETE FROM service_loadbalancer_status
      WHERE tenant_id = $1 AND agent_id = $2 AND service_id = $3
      RETURNING *`,
    [tenantId, agentId, serviceId]
  );
  if (rows.length === 0) return null;
  return mapLb(rows[0]);
}

/**
 * For an agent's reconcile pass: list every (serviceId, latest
 * successful build) pair where this agent is bound but no
 * lb_status_report exists for the (service, env). The caller
 * dispatches a redeploy_service for each row so the agent catches
 * up to the latest image without waiting for a fresh build.
 */
export async function listMissingDeploysForAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<
  Array<{
    serviceId: string;
    serviceName: string;
    branch: string;
    buildId: string;
    gitSha: string;
    imageRef: string;
    pipelineYaml: string;
    pipelineName: string | null;
  }>
> {
  // For each (agent, bound service), pick the most recent successful
  // build that produced an image. Then exclude services that already
  // have a lb_status_report row keyed by this agent — those are
  // "already deployed (or being attempted)".
  //
  // DISTINCT ON (service_id) + ORDER BY service_id, created_at DESC
  // gives us the latest build per service in one round trip.
  const { rows } = await query(
    `WITH latest_builds AS (
       SELECT DISTINCT ON (b.service_id)
              b.service_id,
              b.id          AS build_id,
              b.git_sha,
              b.image_ref,
              b.pipeline_yaml
         FROM service_builds b
        WHERE b.tenant_id = $1
          AND b.status    = 'success'
          AND b.image_ref IS NOT NULL
        ORDER BY b.service_id, b.created_at DESC
     )
     SELECT s.id            AS service_id,
            s.name          AS service_name,
            s.branch        AS branch,
            s.pipeline_name AS pipeline_name,
            lb.build_id,
            lb.git_sha,
            lb.image_ref,
            lb.pipeline_yaml
       FROM agent_services AS j
       JOIN monitored_services s ON s.id = j.service_id
       JOIN latest_builds lb     ON lb.service_id = s.id
  LEFT JOIN service_loadbalancer_status st
         ON st.service_id = s.id AND st.agent_id = $2
      WHERE j.tenant_id = $1
        AND j.agent_id  = $2
        AND st.id IS NULL`,
    [tenantId, agentId]
  );
  return rows.map((r) => ({
    serviceId: String(r.service_id),
    serviceName: String(r.service_name),
    branch: String(r.branch),
    buildId: String(r.build_id),
    gitSha: String(r.git_sha),
    imageRef: String(r.image_ref),
    pipelineYaml: String(r.pipeline_yaml ?? ""),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name)
  }));
}

/**
 * Global cross-tenant drift query — one row per bound (agent, service)
 * with the agent's environment, the latest successful build, and the
 * current lb_status_report (LEFT JOIN, so NULL when not yet deployed).
 *
 * Used by the periodic deployment scheduler. The caller parses each
 * row's pipeline_yaml, resolves the desired config under the agent's
 * env, and compares against currentImageRef/currentBuildId/
 * currentNamespace/currentEnvironment to decide whether to dispatch
 * a redeploy. We don't try to compute drift in SQL because resolving
 * a per-env namespace requires running the kaiad.yaml schema's
 * resolver, which lives in TS.
 */
export async function listAllDeployTargets(
  query: QueryFn
): Promise<
  Array<{
    tenantId: string;
    agentId: string;
    agentEnv: string;
    serviceId: string;
    serviceName: string;
    pipelineName: string | null;
    buildId: string;
    imageRef: string;
    pipelineYaml: string;
    currentImageRef: string | null;
    currentBuildId: string | null;
    currentNamespace: string | null;
    currentEnvironment: string | null;
  }>
> {
  const { rows } = await query(
    `WITH latest_builds AS (
       SELECT DISTINCT ON (b.service_id)
              b.tenant_id,
              b.service_id,
              b.id            AS build_id,
              b.image_ref,
              b.pipeline_yaml
         FROM service_builds b
        WHERE b.status    = 'success'
          AND b.image_ref IS NOT NULL
        ORDER BY b.service_id, b.created_at DESC
     )
     SELECT j.tenant_id,
            j.agent_id,
            a.environment       AS agent_env,
            s.id                AS service_id,
            s.name              AS service_name,
            s.pipeline_name     AS pipeline_name,
            lb.build_id,
            lb.image_ref,
            lb.pipeline_yaml,
            st.image_ref        AS current_image_ref,
            st.build_id         AS current_build_id,
            st.namespace        AS current_namespace,
            st.environment      AS current_environment
       FROM agent_services j
       JOIN agents a              ON a.id = j.agent_id  AND a.tenant_id = j.tenant_id
       JOIN monitored_services s  ON s.id = j.service_id AND s.tenant_id = j.tenant_id
       JOIN latest_builds lb      ON lb.service_id = s.id AND lb.tenant_id = j.tenant_id
  LEFT JOIN service_loadbalancer_status st
         ON st.tenant_id = j.tenant_id
        AND st.service_id = j.service_id
        AND st.agent_id   = j.agent_id`,
    []
  );
  return rows.map((r) => ({
    tenantId: String(r.tenant_id),
    agentId: String(r.agent_id),
    agentEnv: String(r.agent_env ?? "development"),
    serviceId: String(r.service_id),
    serviceName: String(r.service_name),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name),
    buildId: String(r.build_id),
    imageRef: String(r.image_ref),
    pipelineYaml: String(r.pipeline_yaml ?? ""),
    currentImageRef: r.current_image_ref == null ? null : String(r.current_image_ref),
    currentBuildId: r.current_build_id == null ? null : String(r.current_build_id),
    currentNamespace: r.current_namespace == null ? null : String(r.current_namespace),
    currentEnvironment: r.current_environment == null ? null : String(r.current_environment)
  }));
}

/**
 * Like listMissingDeploysForAgent but returns ALL services bound to
 * this agent that have at least one successful build — including ones
 * that already have an lb_status_report row. Caller diffs the resolved
 * config (namespace/instances/domains/loadBalancer) per service across
 * the old vs new environment to decide whether a redeploy is needed.
 *
 * Used by the env-change reconciler. listMissingDeploysForAgent's
 * `st.id IS NULL` filter would hide services that are already running
 * under the OLD env, but those are exactly the ones that need to flip
 * to the NEW env.
 */
export async function listLatestBuildsForBoundServices(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<
  Array<{
    serviceId: string;
    serviceName: string;
    branch: string;
    buildId: string;
    gitSha: string;
    imageRef: string;
    pipelineYaml: string;
    pipelineName: string | null;
  }>
> {
  const { rows } = await query(
    `WITH latest_builds AS (
       SELECT DISTINCT ON (b.service_id)
              b.service_id,
              b.id          AS build_id,
              b.git_sha,
              b.image_ref,
              b.pipeline_yaml
         FROM service_builds b
        WHERE b.tenant_id = $1
          AND b.status    = 'success'
          AND b.image_ref IS NOT NULL
        ORDER BY b.service_id, b.created_at DESC
     )
     SELECT s.id            AS service_id,
            s.name          AS service_name,
            s.branch        AS branch,
            s.pipeline_name AS pipeline_name,
            lb.build_id,
            lb.git_sha,
            lb.image_ref,
            lb.pipeline_yaml
       FROM agent_services AS j
       JOIN monitored_services s ON s.id = j.service_id
       JOIN latest_builds lb     ON lb.service_id = s.id
      WHERE j.tenant_id = $1
        AND j.agent_id  = $2`,
    [tenantId, agentId]
  );
  return rows.map((r) => ({
    serviceId: String(r.service_id),
    serviceName: String(r.service_name),
    branch: String(r.branch),
    buildId: String(r.build_id),
    gitSha: String(r.git_sha),
    imageRef: String(r.image_ref),
    pipelineYaml: String(r.pipeline_yaml ?? ""),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name)
  }));
}

export async function listLoadBalancerStatusForTenant(
  query: QueryFn,
  tenantId: string
): Promise<LoadBalancerStatusRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_loadbalancer_status
      WHERE tenant_id = $1
      ORDER BY observed_at DESC`,
    [tenantId]
  );
  return rows.map(mapLb);
}

export async function getBuildArtifact(
  query: QueryFn,
  buildId: string,
  name: string
): Promise<ServiceBuildArtifactRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM service_build_artifacts WHERE build_id = $1 AND name = $2`,
    [buildId, name]
  );
  return rows.length === 0 ? undefined : mapArtifact(rows[0]);
}
