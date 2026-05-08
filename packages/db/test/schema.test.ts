import { describe, expect, it } from "vitest";
import { coreSchemaSql } from "../src/index.js";

describe("db schema", () => {
  it("contains key tenancy and auth tables", () => {
    expect(coreSchemaSql).toContain("create table if not exists tenants");
    expect(coreSchemaSql).toContain("create table if not exists tenant_memberships");
    expect(coreSchemaSql).toContain("create table if not exists oidc_providers");
  });

  describe("Phase A/B core entities", () => {
    it("defines agents with tenant FK, status check, last_seen_at, name, version, cert, capabilities", () => {
      expect(coreSchemaSql).toContain("create table if not exists agents");
      expect(coreSchemaSql).toMatch(/references tenants\(id\)/);
      expect(coreSchemaSql).toMatch(
        /create table if not exists agents[\s\S]*?check \(status in \([^)]+\)\)/,
      );
      expect(coreSchemaSql).toContain("last_seen_at");
      expect(coreSchemaSql).toContain("name text");
      expect(coreSchemaSql).toContain("version text");
      expect(coreSchemaSql).toContain("cert_fingerprint text");
      expect(coreSchemaSql).toContain("allowed_capabilities text[]");
    });

    it("defines api_credentials with tenant, token_hash, scopes, and revocation columns", () => {
      expect(coreSchemaSql).toContain("create table if not exists api_credentials");
      expect(coreSchemaSql).toMatch(/api_credentials[\s\S]*?token_hash text not null unique/);
      expect(coreSchemaSql).toMatch(/api_credentials[\s\S]*?scopes text\[\] not null default '\{\}'/);
      expect(coreSchemaSql).toMatch(/api_credentials[\s\S]*?last_used_at timestamptz/);
      expect(coreSchemaSql).toMatch(/api_credentials[\s\S]*?revoked_at timestamptz/);
      expect(coreSchemaSql).toContain("api_credentials_tenant_id_idx");
    });

    it("defines ssh_keys with tenant, name, type, private_key_encrypted, local_path", () => {
      expect(coreSchemaSql).toContain("create table if not exists ssh_keys");
      expect(coreSchemaSql).toMatch(/tenant_id text not null references tenants\(id\)/);
      expect(coreSchemaSql).toContain("name text not null");
      expect(coreSchemaSql).toContain("type text not null");
      expect(coreSchemaSql).toContain("private_key_encrypted text");
      expect(coreSchemaSql).toContain("local_path text");
    });

    it("defines monitored_services without an agent_id column (many-to-many via agent_services)", () => {
      expect(coreSchemaSql).toContain("create table if not exists monitored_services");
      expect(coreSchemaSql).toContain("name text not null");
      expect(coreSchemaSql).toContain("git_repo_url text not null");
      expect(coreSchemaSql).toMatch(/ssh_key_id text references ssh_keys\(id\)/);
      expect(coreSchemaSql).toContain("branch text not null");
      expect(coreSchemaSql).toContain("docker_image text");
      expect(coreSchemaSql).toContain("compose_path text");
      // Migration drops the legacy single-FK column at end of bootstrap.
      expect(coreSchemaSql).toMatch(/alter table monitored_services drop column if exists agent_id cascade/);
    });

    it("defines agent_services join table with composite PK and indexes", () => {
      expect(coreSchemaSql).toContain("create table if not exists agent_services");
      expect(coreSchemaSql).toMatch(/agent_id text not null references agents\(id\) on delete cascade/);
      expect(coreSchemaSql).toMatch(/service_id text not null references monitored_services\(id\) on delete cascade/);
      expect(coreSchemaSql).toMatch(/primary key \(agent_id, service_id\)/);
      expect(coreSchemaSql).toContain("agent_services_tenant_id_idx");
      expect(coreSchemaSql).toContain("agent_services_service_id_idx");
    });

    it("defines service_runs with tenant, service, agent FKs and state check", () => {
      expect(coreSchemaSql).toContain("create table if not exists service_runs");
      expect(coreSchemaSql).toMatch(/references monitored_services\(id\)/);
      expect(coreSchemaSql).toMatch(/references agents\(id\)/);
      expect(coreSchemaSql).toMatch(
        /check \(state in \('starting','running','stopped','crashed','unknown'\)\)/,
      );
      expect(coreSchemaSql).toContain("last_heartbeat_at");
    });

    it("drops legacy workflow_graphs table and workflow_graph_id column", () => {
      expect(coreSchemaSql).toContain("drop table if exists workflow_graphs");
      expect(coreSchemaSql).toContain(
        "alter table monitored_services drop column if exists workflow_graph_id"
      );
    });

    it("defines incidents with tenant, service FK, fingerprint, status check, seen timestamps", () => {
      expect(coreSchemaSql).toContain("create table if not exists incidents");
      expect(coreSchemaSql).toMatch(
        /create table if not exists incidents[\s\S]*?check \(status in \([^)]+\)\)/,
      );
      expect(coreSchemaSql).toContain("fingerprint");
      expect(coreSchemaSql).toContain("first_seen_at");
      expect(coreSchemaSql).toContain("last_seen_at");
    });

    it("defines remediation_jobs with tenant, incident FK, executor, status check, created_at", () => {
      expect(coreSchemaSql).toContain("create table if not exists remediation_jobs");
      expect(coreSchemaSql).toMatch(/references incidents\(id\)/);
      expect(coreSchemaSql).toContain("executor");
      expect(coreSchemaSql).toMatch(
        /create table if not exists remediation_jobs[\s\S]*?check \(status in \([^)]+\)\)/,
      );
      expect(coreSchemaSql).toContain("created_at");
    });

    it("defines dedup_keys with unique tenant_id + fingerprint", () => {
      expect(coreSchemaSql).toContain("create table if not exists dedup_keys");
      expect(coreSchemaSql).toMatch(
        /unique \(tenant_id,\s*fingerprint\)|primary key \(tenant_id,\s*fingerprint\)/,
      );
    });

    it("defines audit_logs with tenant, nullable actor, action, target, metadata jsonb", () => {
      expect(coreSchemaSql).toContain("create table if not exists audit_logs");
      expect(coreSchemaSql).toMatch(/actor_id text references users\(id\)[^\n]*/);
      expect(coreSchemaSql).toContain("action text not null");
      expect(coreSchemaSql).toContain("target_type text not null");
      expect(coreSchemaSql).toContain("target_id");
      expect(coreSchemaSql).toContain("metadata_json");
    });

    it("defines agent_enrollment_tokens with tenant, hash, expiry, created_by, optional used_at, optional revoked_at", () => {
      expect(coreSchemaSql).toContain("create table if not exists agent_enrollment_tokens");
      expect(coreSchemaSql).toContain("revoked_at");
      expect(coreSchemaSql).toMatch(/tenant_id text not null references tenants\(id\)/);
      expect(coreSchemaSql).toContain("token_hash text not null");
      expect(coreSchemaSql).toContain("expires_at timestamptz not null");
      expect(coreSchemaSql).toContain("created_by text not null");
      expect(coreSchemaSql).toContain("used_at timestamptz");
    });
  });
});
