// Negative-path tests for the registry routes. Some of these overlap
// with the happy-path tests but are split here so failure modes are
// surveyable in one place.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import {
  ensureRegistryAuth,
  signRegistryToken,
  type RegistryAuthConfig
} from "@sm/registry-auth";
import { registerRegistryRoutes } from "../src/registry/routes.js";

let config: RegistryAuthConfig;

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kaiad-reg-neg-"));
  config = {
    keyPath: path.join(dir, "key.pem"),
    certPath: path.join(dir, "cert.pem"),
    issuer: "kaiad-test",
    service: "kaiad-registry-test"
  };
  ensureRegistryAuth(config);
});

function emptyPool(): any {
  const exec = async () => ({ rows: [] });
  return {
    query: vi.fn(exec),
    connect: vi.fn(async () => ({ query: vi.fn(exec), release: vi.fn() }))
  };
}

function buildApp(pool: any) {
  const app = Fastify();
  registerRegistryRoutes(app, {
    getPool: async () => pool,
    authConfig: config,
    tokenRealm: "https://panel.kaiad.dev/registry/token",
    service: config.service
  });
  return app;
}

function bearerForRepo(repo: string, actions: string[]): string {
  const { token } = signRegistryToken(config, {
    subject: "u",
    access: [{ type: "repository", name: repo, actions: actions as any }]
  });
  return `Bearer ${token}`;
}

describe("unauthenticated", () => {
  it("/v2/<name>/manifests/<ref> returns 401 with WWW-Authenticate Bearer scope", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/manifests/latest"
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('scope="repository:kaiad-agent:pull"');
  });

  it("/v2/<name>/blobs/uploads/ returns 401 + push scope challenge", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/"
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('scope="repository:kaiad-agent:push"');
  });
});

describe("malformed inputs", () => {
  it("rejects malformed Authorization header", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: { authorization: "Bearer not.a.jwt" }
    });
    expect(res.statusCode).toBe(401);
  });

  it("/v2/<name>/blobs/<bad-digest> returns DIGEST_INVALID", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/blobs/sha256:not-hex-at-all",
      headers: { authorization: bearerForRepo("kaiad-agent", ["pull"]) }
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0].code).toBe("DIGEST_INVALID");
  });

  it("PUT manifest with non-buffer body (default JSON parser) is treated as invalid", async () => {
    const app = buildApp(emptyPool());
    // application/json is NOT in KNOWN_MANIFEST_MEDIA_TYPES so the
    // handler responds 415.
    const res = await app.inject({
      method: "PUT",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push"]),
        "content-type": "application/json"
      },
      payload: '{"schemaVersion":2}'
    });
    expect(res.statusCode).toBe(415);
  });

  it("PUT manifest with empty body returns MANIFEST_INVALID", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "PUT",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push"]),
        "content-type": "application/vnd.docker.distribution.manifest.v2+json"
      },
      payload: ""
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0].code).toBe("MANIFEST_INVALID");
  });
});

describe("upload session error paths", () => {
  it("PATCH on unknown upload returns BLOB_UPLOAD_UNKNOWN", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "PATCH",
      url: "/v2/kaiad-agent/blobs/uploads/does-not-exist",
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push"]),
        "content-type": "application/octet-stream"
      },
      payload: Buffer.from("xxx")
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  it("GET status on unknown upload returns BLOB_UPLOAD_UNKNOWN", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/blobs/uploads/does-not-exist",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push"]) }
    });
    expect(res.statusCode).toBe(404);
  });

  it("PUT commit without ?digest= returns DIGEST_INVALID", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "PUT",
      url: "/v2/kaiad-agent/blobs/uploads/some-uuid",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push"]) }
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0].code).toBe("DIGEST_INVALID");
  });

  it("DELETE on unknown upload returns BLOB_UPLOAD_UNKNOWN", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "DELETE",
      url: "/v2/kaiad-agent/blobs/uploads/does-not-exist",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push"]) }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("path dispatch errors", () => {
  it("unknown /v2 subpath returns NAME_UNKNOWN", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "GET",
      url: "/v2/garbage/path/with/no/markers",
      headers: { authorization: bearerForRepo("garbage", ["pull"]) }
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).errors[0].code).toBe("NAME_UNKNOWN");
  });

  it("PUT on /v2/<name>/blobs/<digest> returns 405 (not an allowed action)", async () => {
    const app = buildApp(emptyPool());
    const res = await app.inject({
      method: "PUT",
      url: `/v2/kaiad-agent/blobs/sha256:${"a".repeat(64)}`,
      headers: { authorization: bearerForRepo("kaiad-agent", ["push"]) }
    });
    expect(res.statusCode).toBe(405);
  });
});

describe("503 when DATABASE_URL missing", () => {
  it("catalog returns 503 UNAVAILABLE", async () => {
    const app = Fastify();
    registerRegistryRoutes(app, {
      getPool: async () => null,
      authConfig: config,
      tokenRealm: "https://x/registry/token",
      service: config.service
    });
    const { token } = signRegistryToken(config, {
      subject: "admin",
      access: [{ type: "registry", name: "catalog", actions: ["*"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/_catalog",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).errors[0].code).toBe("UNAVAILABLE");
  });
});
