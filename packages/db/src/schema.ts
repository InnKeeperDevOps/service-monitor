export const coreSchemaSql = `
create table if not exists tenants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  email text not null unique,
  password_hash text,
  created_at timestamptz not null default now()
);

create table if not exists tenant_memberships (
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','operator','viewer')),
  primary key (tenant_id, user_id)
);

create table if not exists oauth_providers (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  provider text not null,
  client_id text not null,
  client_secret_enc text not null
);

create table if not exists oidc_providers (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  issuer_url text not null,
  client_id text not null,
  client_secret_enc text not null
);

create table if not exists ssh_keys (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  type text not null check (type in ('uploaded', 'local_path')),
  private_key_encrypted text,
  local_path text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists agents (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text,
  version text,
  status text not null check (status in ('online','offline','degraded','unknown')),
  last_seen_at timestamptz,
  cert_fingerprint text,
  allowed_capabilities text[] default '{}'
);

-- Agents have a deployment environment so the operator can pick the
-- right per-env block from a service's kaiad.yaml when redeploying.
-- Defaults to 'development' for legacy rows; new agents are typically
-- assigned via the panel after enrollment. Lowercase k8s-style names
-- match pipelineEnvironmentSchema's regex.
alter table agents add column if not exists environment text not null default 'development';

-- The agent's own resolved runtime backend (docker | kubernetes |
-- shell). Set on every heartbeat from the agent's reported value.
-- Nullable until the first runtime-aware heartbeat lands so the UI
-- can render an "unknown" state for newly-enrolled or pre-upgrade
-- agents instead of guessing.
alter table agents add column if not exists runtime_backend text;

create table if not exists agent_enrollment_tokens (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

alter table agent_enrollment_tokens add column if not exists created_at timestamptz not null default now();

alter table agent_enrollment_tokens add column if not exists revoked_at timestamptz;

create table if not exists monitored_services (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  agent_id text references agents(id) on delete set null,
  name text not null,
  git_repo_url text not null,
  ssh_key_id text references ssh_keys(id) on delete set null,
  branch text not null,
  docker_image text,
  compose_path text
);

alter table monitored_services drop column if exists workflow_graph_id cascade;
alter table monitored_services drop column if exists agent_runtime_backend cascade;
-- pipeline_name picks one named entry from a multi-pipeline kaiad.yaml
-- (services: { php: {...}, nginx: {...} }). Null for single-pipeline
-- repos. Two MonitoredServices pointing at the same git repo + branch
-- but different pipeline_names ARE the supported way to model a
-- multi-image project.
alter table monitored_services add column if not exists pipeline_name text;

-- "supporting" services (typically a base/library docker image) are NOT
-- deployed to agents — they just build and serve as build-time inputs
-- for other services via the dependsOn relationship. Refreshed from
-- kaiad.yaml on every successful build.
alter table monitored_services add column if not exists kind text not null default 'deployable';

-- Names of other services in the same tenant whose latest successful
-- build must complete before this service can build. Snapshot of the
-- kaiad.yaml dependsOn array on the latest build. Used both to:
--   (1) gate this service's builds on its deps, and
--   (2) when a dep finishes building, find the services to re-trigger.
-- text[] (not jsonb) so the reverse-lookup uses an array-contains
-- query with a GIN index instead of parsing JSON on every match.
alter table monitored_services add column if not exists depends_on text[] not null default ARRAY[]::text[];
create index if not exists monitored_services_depends_on_gin on monitored_services using gin (depends_on);

-- agent ↔ service binding is many-to-many. The join table is the single
-- source of truth. The legacy monitored_services.agent_id column
-- (non-null for any service that was bound under the old single-FK model)
-- is migrated into the join below, then dropped. Idempotent on re-runs.
create table if not exists agent_services (
  tenant_id text not null references tenants(id) on delete cascade,
  agent_id text not null references agents(id) on delete cascade,
  service_id text not null references monitored_services(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agent_id, service_id)
);

create index if not exists agent_services_tenant_id_idx on agent_services(tenant_id);
create index if not exists agent_services_service_id_idx on agent_services(service_id);

-- Backfill from the legacy single-FK column. Wrapped in a DO block so it's
-- a no-op when monitored_services.agent_id has already been dropped.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'monitored_services' and column_name = 'agent_id'
  ) then
    insert into agent_services (tenant_id, agent_id, service_id)
      select tenant_id, agent_id, id from monitored_services
      where agent_id is not null
      on conflict do nothing;
  end if;
end$$;

alter table monitored_services drop column if exists agent_id cascade;

drop table if exists workflow_graphs cascade;

create table if not exists service_runs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  service_id text not null references monitored_services(id) on delete cascade,
  agent_id text references agents(id) on delete set null,
  state text not null check (state in ('starting','running','stopped','crashed','unknown')),
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists incidents (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  service_id text not null references monitored_services(id) on delete cascade,
  fingerprint text not null,
  message text,
  status text not null check (status in ('open','acknowledged','resolved','closed')),
  event_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists remediation_jobs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  incident_id text not null references incidents(id) on delete cascade,
  executor text not null,
  status text not null check (status in ('pending','running','succeeded','failed','cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists dedup_keys (
  tenant_id text not null references tenants(id) on delete cascade,
  fingerprint text not null,
  cooldown_until timestamptz not null,
  primary key (tenant_id, fingerprint)
);

create table if not exists audit_logs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  actor_id text references users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  metadata_json jsonb not null default '{}'::jsonb
);

create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  tenant_id text not null references tenants(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists api_credentials (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  created_by text,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_credentials_tenant_id_idx on api_credentials(tenant_id);

create table if not exists error_events (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  service_id text not null references monitored_services(id) on delete cascade,
  fingerprint text not null,
  raw_message text not null,
  normalized_message text,
  severity text not null check (severity in ('low','medium','high','critical')),
  confidence real not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  event_count integer not null default 1
);

create table if not exists remediation_plans (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  incident_id text not null references incidents(id) on delete cascade,
  plan_body jsonb not null,
  status text not null check (status in ('queued','running','succeeded','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Build pipeline. Each push to the watched branch (detected by the
-- worker's git ls-remote loop) creates a row here. Status transitions:
--   queued -> running -> success | failed | no_pipeline
-- The "no_pipeline" status is a successful "skip" — repo had no
-- kaiad.yaml at the build SHA. We still record the SHA so the poller
-- does not re-enqueue it on the next tick. image_ref is set on success
-- and is the immutable registry digest reference (reg/svc@sha256:...).
create table if not exists service_builds (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  service_id text not null references monitored_services(id) on delete cascade,
  -- Empty string for a manual build that has not yet had its SHA
  -- resolved by the worker. The worker rewrites this on claim before
  -- starting the actual build.
  git_sha text not null default '',
  branch text not null,
  status text not null check (status in ('queued','running','success','failed','no_pipeline')),
  image_ref text,
  log text not null default '',
  pipeline_yaml text,
  failure_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Whether the build was queued by the periodic poller or explicitly
-- triggered by an operator clicking "Start build" in the panel. Manual
-- builds bypass the poller's same-SHA dedupe AND emit a redeploy_service
-- agent command on success.
alter table service_builds add column if not exists triggered_by text not null default 'poll'
  check (triggered_by in ('poll', 'manual'));

create index if not exists service_builds_service_id_idx
  on service_builds(service_id, created_at desc);
create index if not exists service_builds_status_idx
  on service_builds(status, created_at);
-- The unique index on (service_id, git_sha) was here originally for
-- poller idempotency, but it blocks manual rebuilds at the same SHA.
-- The poller dedupes via getLatestBuildSha (filtered to triggered_by='poll')
-- in app code, which is enough — we don't need to enforce at DB level.
drop index if exists service_builds_service_sha_uniq;

-- Load balancer / ingress observation. The agent reports the
-- assigned external IP (and / or hostname for cloud providers that
-- give DNS names instead) for each Service/Ingress it deployed via
-- redeploy_service. Keyed (service_id, environment) since one
-- service can have a different LB per env.
create table if not exists service_loadbalancer_status (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  service_id text not null references monitored_services(id) on delete cascade,
  -- Which agent produced this observation. Useful when one service
  -- is deployed across multiple agents (HA / multi-cluster) so we
  -- can show which cluster the IP belongs to.
  agent_id text references agents(id) on delete set null,
  environment text not null,
  -- Mirrors the loadBalancer.type from the resolved kaiad.yaml block:
  -- 'none' | 'k8s' | 'metallb' | 'nginx'
  lb_type text not null,
  -- Externally-assigned IPv4/IPv6. NULL when none reported (e.g.
  -- cluster gave hostname instead, or assignment still pending).
  external_ip text,
  -- Externally-assigned DNS hostname (AWS NLB-style). NULL when not
  -- applicable.
  external_hostname text,
  -- Ports actually exposed on the LB. JSON array of
  -- { port, name, protocol, target_port }.
  ports jsonb not null default '[]'::jsonb,
  -- Domain rules that point at this LB. JSON array of
  -- { host, port, protocol }. Mirrored from the resolved kaiad.yaml
  -- so the panel can show domain → IP without re-parsing yaml.
  domains jsonb not null default '[]'::jsonb,
  -- Free-form per-type detail. e.g. metallb → { addressPool }, nginx
  -- → { ingressClass, tlsSecret }.
  detail jsonb not null default '{}'::jsonb,
  -- k8s namespace or docker project name the service was deployed to.
  -- Echoed verbatim from the agent's report; the same service in
  -- different envs typically lands in different namespaces.
  namespace text not null default '',
  observed_at timestamptz not null default now(),
  unique (service_id, environment)
);

-- Idempotent ALTER for existing dev DBs that pre-date the namespace column.
alter table service_loadbalancer_status add column if not exists namespace text not null default '';
-- The image the agent actually applied + the source build that produced
-- it. Used by the panel's Agents page to show "what's running here".
alter table service_loadbalancer_status add column if not exists image_ref text;
alter table service_loadbalancer_status add column if not exists build_id text;

create index if not exists service_loadbalancer_status_tenant_id_idx
  on service_loadbalancer_status(tenant_id);

create table if not exists service_build_artifacts (
  build_id text not null references service_builds(id) on delete cascade,
  name text not null,
  size_bytes bigint not null,
  sha256 text not null,
  -- Path is relative to KAIAD_DATA_DIR/builds/<build_id>/. Stored
  -- separately so the API can stream the file without parsing the name.
  rel_path text not null,
  created_at timestamptz not null default now(),
  primary key (build_id, name)
);

-- ─── Native OCI distribution registry (kaiad-hosted) ────────────────────
-- Replaces the registry:2 sidecar. Blob bytes live in pg_largeobject
-- (streamable via lo_*); manifests are inline BYTEA since they're <1MB.
-- All tables are global (not tenant-scoped) — current panel model is
-- "this Kaiad instance hosts one registry, shared by all tenants."

create table if not exists registry_blobs (
  -- "sha256:<hex>". The leading scheme is part of the PK so downloads
  -- can use the on-the-wire digest verbatim.
  digest text primary key,
  -- Content-type the blob was uploaded with. Informational only; pulls
  -- echo it back via Content-Type but the OCI spec doesn't require it
  -- to be set or accurate.
  media_type text,
  size_bytes bigint not null,
  -- Postgres Large Object oid. Created at upload-commit time via
  -- lo_create(); the bytes are written in 64K chunks via lowrite().
  -- Reads use loread() over the same oid inside a tx.
  content_oid oid not null,
  created_at timestamptz not null default now()
);

create table if not exists registry_manifests (
  -- "sha256:<hex>" of body, computed at PUT time.
  digest text primary key,
  -- Repository this manifest was first pushed under. The same content
  -- could in theory be pushed to multiple repos with different digests
  -- (no — same content has the same digest). Kept here so the panel can
  -- show "which repo does this manifest belong to" without joining tags.
  repo text not null,
  -- "application/vnd.docker.distribution.manifest.v2+json" or the OCI
  -- variants ("application/vnd.oci.image.manifest.v1+json"). Echoed in
  -- the Content-Type of GET responses — clients use it to decide how to
  -- parse the body.
  media_type text not null,
  -- The exact JSON bytes the client uploaded. Stored byte-for-byte so
  -- the digest stays stable on re-fetch.
  body bytea not null,
  size_bytes bigint not null,
  -- Parsed references for GC. Null/empty for manifest lists (which
  -- reference other manifests instead).
  config_digest text,
  layer_digests text[] not null default '{}',
  -- Other manifests referenced (for image-index / manifest-list).
  referenced_manifest_digests text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists registry_manifests_repo_idx on registry_manifests(repo);

create table if not exists registry_tags (
  repo text not null,
  tag text not null,
  -- Tags are mutable: pushing a new manifest under the same name
  -- overwrites this row. Old manifest stays in registry_manifests until
  -- GC reaps it (no other tag references it AND no manifest list
  -- references it).
  manifest_digest text not null references registry_manifests(digest) on delete restrict,
  updated_at timestamptz not null default now(),
  primary key (repo, tag)
);
create index if not exists registry_tags_repo_idx on registry_tags(repo);

-- Blob upload sessions. Client posts to /v2/<name>/blobs/uploads/,
-- gets a uuid + Location, then PATCHes chunks and PUTs to commit.
-- content_oid is allocated on session start; chunks lowrite() into it.
-- On commit, the oid is renamed into registry_blobs.content_oid and
-- the session row is deleted. On cancel/expiry, lo_unlink() reclaims.
create table if not exists registry_uploads (
  uuid text primary key,
  repo text not null,
  content_oid oid not null,
  received_bytes bigint not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists registry_uploads_repo_idx on registry_uploads(repo);
`;
