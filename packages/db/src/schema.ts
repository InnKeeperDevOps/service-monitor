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

create table if not exists workflow_graphs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  service_id text not null references monitored_services(id) on delete cascade,
  version integer not null,
  graph_json jsonb not null,
  is_active boolean not null default false
);

alter table monitored_services add column if not exists workflow_graph_id text references workflow_graphs(id) on delete set null;

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
`;
