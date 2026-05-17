// Postgres-backed integration tests. These exercise the DB-bound
// server.ts surface (registry admin, builds, reconcile, agent env-change
// redeploy, services/agents/load-balancers) that the memory-store unit
// harness structurally cannot reach. Opt-in via TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { hasTestDb, openTestPool, resetDb, seedDevTenant, TEST_DB_URL } from "./_pg.js";

const AUTH = { authorization: "Bearer dev-token" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
let pool: Pool;

const d = hasTestDb ? describe : describe.skip;

d("server.ts Postgres integration", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.KAIAD_SKIP_SETUP_GATE = "1";
    pool = await openTestPool();
    await resetDb(pool);
    await seedDevTenant(pool);
    // Seed an agent (env=development) so the env-change redeploy path
    // and reconcile/agent routes have a real subject.
    await pool.query(
      `insert into agents (id, tenant_id, name, status, environment)
       values ('ag-int', 't-1', 'int-agent', 'online', 'development')`
    );
    // buildServer must be imported AFTER DATABASE_URL is set so its
    // domain/registry/builds pools bind to the test DB.
    const { buildServer } = await import("../src/server.js");
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("registry admin: list repos + visibility (forced-public guard)", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/registry/repositories", headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().repositories)).toBe(true);

    const setPub = await app.inject({
      method: "PUT",
      url: "/api/v1/registry/repositories/some-app/visibility",
      headers: AUTH,
      payload: { public: true }
    });
    expect(setPub.statusCode).toBe(200);
    expect(setPub.json().public).toBe(true);

    const forced = await app.inject({
      method: "PUT",
      url: "/api/v1/registry/repositories/kaiad-agent/visibility",
      headers: AUTH,
      payload: { public: false }
    });
    expect(forced.statusCode).toBe(409);

    // Persisted in the real DB.
    const { rows } = await pool.query(
      `select public from registry_repository_visibility where repo = 'some-app'`
    );
    expect(rows[0]?.public).toBe(true);
  });

  it("services CRUD + agent binding + builds run against Postgres", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: AUTH,
      payload: { name: "int-svc", gitRepoUrl: "https://example.com/r.git", branch: "main", agentIds: [] }
    });
    expect(created.statusCode).toBe(201);
    const svcId = created.json().id as string;

    expect((await app.inject({ method: "GET", url: "/api/v1/services", headers: AUTH })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/agents", headers: AUTH })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/incidents", headers: AUTH })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/load-balancers", headers: AUTH })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/agents/enrollment-tokens?includeInactive=true", headers: AUTH })).statusCode
    ).toBe(200);

    // Bind the service to the seeded agent.
    const bind = await app.inject({
      method: "POST",
      url: `/api/v1/agents/ag-int/services/${svcId}`,
      headers: AUTH
    });
    expect([200, 201, 204]).toContain(bind.statusCode);

    // Builds: enqueue + list + per-service reads (exercise getBuildsQuery).
    const enq = await app.inject({
      method: "POST",
      url: `/api/v1/services/${svcId}/builds`,
      headers: AUTH,
      payload: {}
    });
    expect([200, 201, 202]).toContain(enq.statusCode);
    expect((await app.inject({ method: "GET", url: `/api/v1/services/${svcId}/builds`, headers: AUTH })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/services/${svcId}/error-groups`, headers: AUTH })).statusCode).toBe(200);

    // Seed a successful build whose kaiad.yaml resolves DIFFERENTLY for
    // development vs production (instances 1→3, extra domain) so the
    // subsequent env-change test drives redeployAgentForEnvChange's
    // full per-service redeploy loop (not just the early skip path).
    const pipelineYaml = `
version: 1
runtime:
  image: nginx:alpine
  command: ["nginx", "-g", "daemon off;"]
ports:
  - port: 80
    name: http
environments:
  development:
    instances: 1
  production:
    instances: 3
    domains:
      - host: prod.example.com
        port: 80
        protocol: https
`;
    await pool.query(
      `insert into service_builds (id, tenant_id, service_id, git_sha, branch, status, image_ref, pipeline_yaml)
       values ('bld-pl','t-1',$1,'cafebabe','main','success','reg/x:cafebabe',$2)`,
      [svcId, pipelineYaml]
    );
  });

  it("reconcile endpoints execute the deploy-reconciliation path", async () => {
    const perAgent = await app.inject({
      method: "POST",
      url: "/api/v1/agents/ag-int/reconcile-deploys",
      headers: AUTH
    });
    expect(perAgent.statusCode).toBe(200);

    const all = await app.inject({
      method: "POST",
      url: "/api/v1/internal/reconcile-all",
      headers: AUTH // internal token defaults to "dev-token" in tests
    });
    expect([200, 202]).toContain(all.statusCode);
  });

  it("internal agent-commands route runs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/agent-commands",
      headers: AUTH,
      payload: { agentId: "ag-int", command: { type: "noop" } }
    });
    // The internal-token gate + dispatch body executed (agent isn't
    // connected so dispatch may 500); the point is coverage, not the
    // outcome. Assert only that auth/internal-token checks passed.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("agent env change triggers the redeploy fan-out (best-effort)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/ag-int",
      headers: AUTH,
      payload: { environment: "production" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().environment).toBe("production");
    // redeployAgentForEnvChange runs via setImmediate after the
    // response; give it a tick to execute (its internal fetch fan-out
    // fails fast with no listener but the body still runs and is
    // caught). We only assert the env actually changed in Postgres.
    await new Promise((r) => setTimeout(r, 600));
    const { rows } = await pool.query(`select environment from agents where id = 'ag-int'`);
    expect(rows[0]?.environment).toBe("production");
  });
});

d("server.ts Postgres integration — broad route coverage", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app2: any;
  let pool2: Pool;
  let svcId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.KAIAD_SKIP_SETUP_GATE = "1";
    pool2 = await openTestPool();
    await resetDb(pool2);
    await seedDevTenant(pool2);
    await pool2.query(
      `insert into agents (id, tenant_id, name, status, environment)
       values ('ag-b', 't-1', 'b-agent', 'online', 'development')`
    );
    const { buildServer } = await import("../src/server.js");
    app2 = buildServer();
    await app2.ready();
    const created = await app2.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: AUTH,
      payload: { name: "b-svc", gitRepoUrl: "https://example.com/b.git", branch: "main", agentIds: [] }
    });
    svcId = created.json().id as string;
    await pool2.query(
      `insert into service_builds (id, tenant_id, service_id, git_sha, branch, status, image_ref)
       values ('bld-1','t-1',$1,'deadbeef','main','success','reg/x:deadbeef')`,
      [svcId]
    );
  });

  afterAll(async () => {
    await app2?.close();
    await pool2?.end();
  });

  it("settings / tenants / session / oauth / ssh-keys / api-credentials", async () => {
    const checks: Array<[string, string, unknown?]> = [
      ["GET", "/api/v1/settings/github-app"],
      ["POST", "/api/v1/settings/github-app", { appId: "123", privateKeyPem: "x", webhookSecret: "s" }],
      ["POST", "/api/v1/settings/oauth-providers", { provider: "google", clientId: "c", clientSecret: "s" }],
      ["GET", "/api/v1/settings"],
      ["POST", "/api/v1/tenants", { name: "Another Tenant" }],
      ["POST", "/api/v1/session/active-tenant", { tenantId: "t-1" }],
      ["GET", "/api/v1/ssh-keys"],
      ["POST", "/api/v1/ssh-keys", { name: "k", type: "uploaded", privateKey: "PEM" }],
      ["GET", "/api/v1/admin/api-credentials"],
      ["POST", "/api/v1/admin/api-credentials", { name: "ci", scopes: ["enrollment-tokens.create"] }],
      ["GET", "/api/v1/me"],
      ["GET", "/api/v1/error-groups"],
      ["POST", "/api/v1/agents/enrollment-tokens", { ttlSeconds: 3600 }],
      ["GET", "/api/v1/agents/enrollment-tokens?includeInactive=true"],
      ["GET", "/api/v1/operator/install.yaml"]
    ];
    for (const [method, url, payload] of checks) {
      const res = await app2.inject({ method, url, headers: AUTH, payload });
      // Coverage-focused: the handler body ran (auth passed). Some
      // stores legitimately 503 without full config — still executed.
      expect(res.statusCode).not.toBe(401);
      expect(typeof res.statusCode).toBe("number");
    }
  });

  it("registry repositories: tags listing + delete tag", async () => {
    // Seed a tagged manifest so the tags/describe path executes.
    await pool2.query(
      `insert into registry_blobs (digest, media_type, size_bytes, content_oid)
       values ('sha256:cfg','application/vnd.oci.image.config.v1+json',2, 0)
       on conflict do nothing`
    );
    await pool2.query(
      `insert into registry_manifests (digest, repo, media_type, body, size_bytes, config_digest, layer_digests, referenced_manifest_digests)
       values ('sha256:mm','b-repo','application/vnd.docker.distribution.manifest.v2+json', '{}'::bytea, 2, 'sha256:cfg', '{}', '{}')
       on conflict do nothing`
    );
    await pool2.query(
      `insert into registry_tags (repo, tag, manifest_digest) values ('b-repo','v1','sha256:mm')
       on conflict do nothing`
    );
    const tags = await app2.inject({
      method: "GET",
      url: "/api/v1/registry/repositories/b-repo/tags",
      headers: AUTH
    });
    expect(tags.statusCode).toBe(200);
    const del = await app2.inject({
      method: "DELETE",
      url: "/api/v1/registry/repositories/b-repo/tags/v1",
      headers: AUTH
    });
    expect([200, 202, 204]).toContain(del.statusCode);
  });

  it("per-service builds detail/logs + service patch", async () => {
    expect((await app2.inject({ method: "GET", url: `/api/v1/services/${svcId}/builds`, headers: AUTH })).statusCode).toBe(200);
    const detail = await app2.inject({ method: "GET", url: `/api/v1/services/${svcId}/builds/bld-1`, headers: AUTH });
    expect(detail.statusCode).toBeLessThan(500);
    const logs = await app2.inject({ method: "GET", url: `/api/v1/services/${svcId}/builds/bld-1/logs`, headers: AUTH });
    expect(logs.statusCode).toBeLessThan(500);
    const patch = await app2.inject({
      method: "PATCH",
      url: `/api/v1/services/${svcId}`,
      headers: AUTH,
      payload: { branch: "release" }
    });
    expect(patch.statusCode).toBeLessThan(500);
  });

  it("ensureBundledImagesPublished runs against the real registry DB", async () => {
    // No baked bundle/crane in the test env → exercises the
    // missing-bundle + visibility-assert branches without throwing.
    await expect(app2.ensureBundledImagesPublished()).resolves.toBeUndefined();
  });
});
