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
`;
