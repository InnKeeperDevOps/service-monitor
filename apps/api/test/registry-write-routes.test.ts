// Route tests for the Phase 2 write path. The pool is mocked at the
// pg-protocol level: every SQL fragment we care about (lo_*, registry_*
// tables) returns canned responses. This validates the HTTP contract
// and dispatch logic without spinning up a real Postgres.
//
// End-to-end byte-level correctness (real crane push / crane pull byte
// compare) lives in e2e/acceptance/test/at-registry.test.ts and only
// runs when RUN_ACCEPTANCE=1.

import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "node:crypto";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kaiad-reg-w-"));
  config = {
    keyPath: path.join(dir, "key.pem"),
    certPath: path.join(dir, "cert.pem"),
    issuer: "kaiad-test",
    service: "kaiad-registry-test"
  };
  ensureRegistryAuth(config);
});

// ─── Stateful pool mock ─────────────────────────────────────────────────
// Tracks blob oids (in-memory Buffer per oid), upload sessions,
// manifests, and tags. Implements just enough lo_* + registry_* SQL
// to make the route handlers happy.

interface FakeState {
  /** oid → bytes */
  blobs: Map<number, Buffer>;
  /** sha256 digest → blob row */
  blobRows: Map<string, { mediaType: string | null; sizeBytes: number; contentOid: number }>;
  /** uuid → upload session row */
  uploads: Map<
    string,
    { repo: string; contentOid: number; receivedBytes: number; expiresAt: string }
  >;
  /** manifest digest → row */
  manifests: Map<
    string,
    {
      repo: string;
      mediaType: string;
      body: Buffer;
      configDigest: string | null;
      layerDigests: string[];
      referencedManifestDigests: string[];
    }
  >;
  /** "repo|tag" → digest */
  tags: Map<string, string>;
  nextOid: number;
}

function newState(): FakeState {
  return {
    blobs: new Map(),
    blobRows: new Map(),
    uploads: new Map(),
    manifests: new Map(),
    tags: new Map(),
    nextOid: 1000
  };
}

function makeFakePool(state: FakeState): any {
  // For lo_open/loread/lowrite we maintain an internal fd map per
  // transaction. Phase 2 currently only uses lo_open/loread/lo_close
  // for read streams (computeBlobDigest) and lo_put for writes.
  const fds = new Map<number, { oid: number; offset: number }>();
  let nextFd = 100;

  const exec = async (sql: string, params: any[] = []) => {
    const s = sql.trim();
    // ── Large Object operations ─────────────────────────────────────
    if (/SELECT lo_create/i.test(s)) {
      const oid = state.nextOid++;
      state.blobs.set(oid, Buffer.alloc(0));
      return { rows: [{ oid }] };
    }
    if (/SELECT lo_put/i.test(s)) {
      const [oid, offset, data] = params;
      const cur = state.blobs.get(Number(oid)) ?? Buffer.alloc(0);
      const off = Number(offset);
      const next = Buffer.alloc(Math.max(cur.length, off + data.length));
      cur.copy(next);
      data.copy(next, off);
      state.blobs.set(Number(oid), next);
      return { rows: [{ lo_put: "" }] };
    }
    if (/SELECT lo_unlink/i.test(s)) {
      state.blobs.delete(Number(params[0]));
      return { rows: [{ lo_unlink: 1 }] };
    }
    if (/SELECT lo_open/i.test(s)) {
      const fd = nextFd++;
      fds.set(fd, { oid: Number(params[0]), offset: 0 });
      return { rows: [{ fd }] };
    }
    if (/SELECT lo_close/i.test(s)) {
      fds.delete(Number(params[0]));
      return { rows: [{ lo_close: 0 }] };
    }
    if (/SELECT lo_lseek64/i.test(s)) {
      const [fd, offset, whence] = params;
      const entry = fds.get(Number(fd));
      if (!entry) throw new Error("bad fd");
      const blob = state.blobs.get(entry.oid) ?? Buffer.alloc(0);
      if (Number(whence) === 0) entry.offset = Number(offset);
      else if (Number(whence) === 2) entry.offset = blob.length;
      return { rows: [{ sz: String(entry.offset) }] };
    }
    if (/SELECT loread/i.test(s)) {
      const [fd, want] = params;
      const entry = fds.get(Number(fd));
      if (!entry) throw new Error("bad fd");
      const blob = state.blobs.get(entry.oid) ?? Buffer.alloc(0);
      const chunk = blob.subarray(entry.offset, entry.offset + Number(want));
      entry.offset += chunk.length;
      return { rows: [{ chunk }] };
    }
    // ── Transaction control (no-op for tests) ───────────────────────
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };

    // ── registry_blobs ──────────────────────────────────────────────
    if (/INSERT INTO registry_blobs/i.test(s)) {
      const [digest, mediaType, sizeBytes, contentOid] = params;
      state.blobRows.set(digest, {
        mediaType,
        sizeBytes: Number(sizeBytes),
        contentOid: Number(contentOid)
      });
      return { rows: [] };
    }
    if (/FROM registry_blobs WHERE digest/i.test(s) && /DELETE/i.test(s)) {
      const digest = params[0];
      const row = state.blobRows.get(digest);
      if (!row) return { rows: [] };
      state.blobRows.delete(digest);
      return {
        rows: [
          {
            digest,
            media_type: row.mediaType,
            size_bytes: row.sizeBytes,
            content_oid: row.contentOid,
            created_at: new Date()
          }
        ]
      };
    }
    if (/FROM registry_blobs WHERE digest/i.test(s)) {
      const digest = params[0];
      const row = state.blobRows.get(digest);
      if (!row) return { rows: [] };
      return {
        rows: [
          {
            digest,
            media_type: row.mediaType,
            size_bytes: row.sizeBytes,
            content_oid: row.contentOid,
            created_at: new Date()
          }
        ]
      };
    }

    // ── registry_uploads ────────────────────────────────────────────
    if (/INSERT INTO registry_uploads/i.test(s)) {
      const [uuid, repo, contentOid, expiresAt] = params;
      state.uploads.set(uuid, {
        repo,
        contentOid: Number(contentOid),
        receivedBytes: 0,
        expiresAt
      });
      return { rows: [] };
    }
    if (/FROM registry_uploads WHERE uuid/i.test(s) && /DELETE/i.test(s)) {
      const uuid = params[0];
      const u = state.uploads.get(uuid);
      if (!u) return { rows: [] };
      state.uploads.delete(uuid);
      return {
        rows: [
          {
            uuid,
            repo: u.repo,
            content_oid: u.contentOid,
            received_bytes: u.receivedBytes,
            expires_at: u.expiresAt,
            created_at: new Date()
          }
        ]
      };
    }
    if (/UPDATE registry_uploads/i.test(s)) {
      const [uuid, received] = params;
      const u = state.uploads.get(uuid);
      if (u) u.receivedBytes = Number(received);
      return { rows: [] };
    }
    if (/FROM registry_uploads WHERE uuid/i.test(s)) {
      const uuid = params[0];
      const u = state.uploads.get(uuid);
      if (!u) return { rows: [] };
      return {
        rows: [
          {
            uuid,
            repo: u.repo,
            content_oid: u.contentOid,
            received_bytes: u.receivedBytes,
            expires_at: u.expiresAt,
            created_at: new Date()
          }
        ]
      };
    }

    // ── content-addressed cross-repo helpers (match BEFORE the
    //    generic registry_manifests / registry_tags branches) ────────
    const tagPointsAt = (repo: string, digest: string) => {
      for (const [key, d] of state.tags.entries()) {
        if (key.startsWith(`${repo}|`) && d === digest) return true;
      }
      return false;
    };
    const childOfTagged = (repo: string, digest: string) => {
      for (const [key, parentDigest] of state.tags.entries()) {
        if (!key.startsWith(`${repo}|`)) continue;
        const pm = state.manifests.get(parentDigest);
        if (pm?.referencedManifestDigests?.includes(digest)) return true;
      }
      return false;
    };
    // Order matters: the EXISTS/LIMIT-1 probes below also contain a
    // JOIN in their subqueries, so match them BEFORE the getByTag JOIN.
    // isManifestReachableInRepo — `SELECT 1 WHERE EXISTS (...)`.
    if (/^\s*SELECT 1\s+WHERE EXISTS/i.test(s)) {
      const [repo, digest] = params;
      return tagPointsAt(repo, digest) || childOfTagged(repo, digest)
        ? { rows: [{ ok: 1 }] }
        : { rows: [] };
    }
    // repoHasTagForManifest — `SELECT 1 FROM registry_tags ... LIMIT 1`.
    if (/SELECT 1 FROM registry_tags WHERE repo/i.test(s) && /manifest_digest/i.test(s)) {
      const [repo, digest] = params;
      return tagPointsAt(repo, digest) ? { rows: [{ ok: 1 }] } : { rows: [] };
    }
    // getRegistryManifestByTag — `SELECT m.* FROM registry_manifests m
    // JOIN registry_tags t ...`. Repo-scoped by the tag, NOT by the
    // manifest row's first-writer repo.
    if (/SELECT m\.\*\s+FROM registry_manifests m\s+JOIN registry_tags/i.test(s)) {
      const [repo, tag] = params;
      const digest = state.tags.get(`${repo}|${tag}`);
      const m = digest ? state.manifests.get(digest) : undefined;
      if (!digest || !m) return { rows: [] };
      return {
        rows: [
          {
            digest,
            repo: m.repo,
            media_type: m.mediaType,
            body: m.body,
            size_bytes: m.body.length,
            config_digest: m.configDigest,
            layer_digests: m.layerDigests,
            referenced_manifest_digests: m.referencedManifestDigests,
            created_at: new Date()
          }
        ]
      };
    }
    // deleteRegistryManifestIfUnreferenced (aliased table dodges the
    // generic delete regex below — handle it explicitly).
    if (/DELETE FROM registry_manifests/i.test(s) && /NOT EXISTS/i.test(s)) {
      const digest = params[0];
      let referenced = false;
      for (const d of state.tags.values()) if (d === digest) referenced = true;
      for (const m of state.manifests.values()) {
        if (m.referencedManifestDigests?.includes(digest)) referenced = true;
      }
      if (referenced || !state.manifests.has(digest)) return { rows: [] };
      state.manifests.delete(digest);
      return { rows: [{ digest }] };
    }

    // ── registry_manifests ──────────────────────────────────────────
    if (/INSERT INTO registry_manifests/i.test(s)) {
      const [digest, repo, mediaType, body, , configDigest, layerDigests, refManifestDigests] = params;
      state.manifests.set(digest, {
        repo,
        mediaType,
        body,
        configDigest,
        layerDigests,
        referencedManifestDigests: refManifestDigests
      });
      return { rows: [] };
    }
    if (/FROM registry_manifests WHERE digest/i.test(s) && /DELETE/i.test(s)) {
      const digest = params[0];
      if (!state.manifests.has(digest)) return { rows: [] };
      state.manifests.delete(digest);
      return { rows: [{ digest }] };
    }
    if (/FROM registry_manifests WHERE digest/i.test(s)) {
      const digest = params[0];
      const m = state.manifests.get(digest);
      if (!m) return { rows: [] };
      return {
        rows: [
          {
            digest,
            repo: m.repo,
            media_type: m.mediaType,
            body: m.body,
            size_bytes: m.body.length,
            config_digest: m.configDigest,
            layer_digests: m.layerDigests,
            referenced_manifest_digests: m.referencedManifestDigests,
            created_at: new Date()
          }
        ]
      };
    }

    // ── registry_tags ───────────────────────────────────────────────
    if (/INSERT INTO registry_tags/i.test(s)) {
      const [repo, tag, digest] = params;
      state.tags.set(`${repo}|${tag}`, digest);
      return { rows: [] };
    }
    if (/FROM registry_tags WHERE repo/i.test(s) && /DELETE/i.test(s)) {
      const [repo, tag] = params;
      const key = `${repo}|${tag}`;
      if (!state.tags.has(key)) return { rows: [] };
      state.tags.delete(key);
      return { rows: [{ tag }] };
    }
    if (/FROM registry_tags WHERE repo/i.test(s)) {
      const repo = params[0];
      const rows: any[] = [];
      for (const [key, digest] of state.tags.entries()) {
        const [r, t] = key.split("|");
        if (r === repo) {
          rows.push({ repo: r, tag: t, manifest_digest: digest, updated_at: new Date() });
        }
      }
      return { rows };
    }

    // Default: empty result.
    return { rows: [] };
  };

  const client = { query: vi.fn(exec), release: vi.fn() };
  return {
    query: vi.fn(exec),
    connect: vi.fn(async () => client)
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

// ─── Tests ──────────────────────────────────────────────────────────────

describe("upload init", () => {
  it("starts a session and returns Location + Range: 0-0", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const res = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers["location"]).toMatch(/^\/v2\/kaiad-agent\/blobs\/uploads\//);
    expect(res.headers["docker-upload-uuid"]).toBeTruthy();
    expect(res.headers["range"]).toBe("0-0");
    expect(state.uploads.size).toBe(1);
  });

  it("rejects without push scope", async () => {
    const app = buildApp(makeFakePool(newState()));
    const res = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["pull"]) }
    });
    expect(res.statusCode).toBe(403);
  });

  // Regression: crane sends `Content-Type: application/json` with an
  // empty body on this endpoint. Fastify's default JSON parser
  // FST_ERR_CTP_EMPTY_JSON_BODY-rejects it, so the registry plugin
  // replaces it with a lenient version that accepts empty bodies.
  it("accepts Content-Type: application/json with empty body", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const res = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/json"
      }
    });
    expect(res.statusCode).toBe(202);
    expect(state.uploads.size).toBe(1);
  });
});

describe("cross-repo blob mount", () => {
  it("returns 201 immediately when the blob exists", async () => {
    const state = newState();
    const digest = "sha256:" + "a".repeat(64);
    state.blobRows.set(digest, { mediaType: null, sizeBytes: 100, contentOid: 42 });
    const app = buildApp(makeFakePool(state));
    const res = await app.inject({
      method: "POST",
      url: `/v2/new-repo/blobs/uploads/?mount=${digest}&from=other-repo`,
      headers: { authorization: bearerForRepo("new-repo", ["push", "pull"]) }
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["location"]).toBe(`/v2/new-repo/blobs/${digest}`);
    expect(res.headers["docker-content-digest"]).toBe(digest);
  });

  it("falls through to a new session when source blob is missing", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const digest = "sha256:" + "f".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: `/v2/new-repo/blobs/uploads/?mount=${digest}&from=other-repo`,
      headers: { authorization: bearerForRepo("new-repo", ["push", "pull"]) }
    });
    expect(res.statusCode).toBe(202);
    expect(state.uploads.size).toBe(1);
  });
});

describe("PATCH upload chunk", () => {
  it("appends bytes and advances Range", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));

    const init = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    const uuid = init.headers["docker-upload-uuid"] as string;

    const body = Buffer.from("hello world", "utf8");
    const patch = await app.inject({
      method: "PATCH",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/octet-stream"
      },
      payload: body
    });
    expect(patch.statusCode).toBe(202);
    expect(patch.headers["range"]).toBe(`0-${body.length - 1}`);
    expect(state.uploads.get(uuid)?.receivedBytes).toBe(body.length);
  });

  it("rejects out-of-order Content-Range with 416", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const init = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    const uuid = init.headers["docker-upload-uuid"] as string;

    // Server expects start=0 but client claims start=100.
    const res = await app.inject({
      method: "PATCH",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/octet-stream",
        "content-range": "100-199"
      },
      payload: Buffer.from("x".repeat(100))
    });
    expect(res.statusCode).toBe(416);
  });
});

describe("PUT upload commit", () => {
  it("commits a single-PATCH upload and matches digest", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));

    const init = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    const uuid = init.headers["docker-upload-uuid"] as string;

    const body = Buffer.from("hello world", "utf8");
    await app.inject({
      method: "PATCH",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/octet-stream"
      },
      payload: body
    });

    const digest = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
    const put = await app.inject({
      method: "PUT",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}?digest=${digest}`,
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    expect(put.statusCode).toBe(201);
    expect(put.headers["docker-content-digest"]).toBe(digest);
    expect(put.headers["location"]).toBe(`/v2/kaiad-agent/blobs/${digest}`);
    expect(state.blobRows.has(digest)).toBe(true);
    expect(state.uploads.has(uuid)).toBe(false);
  });

  it("rejects digest mismatch and cleans up the oid", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const init = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    const uuid = init.headers["docker-upload-uuid"] as string;
    const body = Buffer.from("hello world");
    await app.inject({
      method: "PATCH",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/octet-stream"
      },
      payload: body
    });

    const wrongDigest = "sha256:" + "0".repeat(64);
    const put = await app.inject({
      method: "PUT",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}?digest=${wrongDigest}`,
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    expect(put.statusCode).toBe(400);
    expect(JSON.parse(put.body).errors[0].code).toBe("DIGEST_INVALID");
    // Session cleaned up and blob not committed.
    expect(state.uploads.has(uuid)).toBe(false);
    expect(state.blobRows.size).toBe(0);
  });
});

describe("monolithic POST upload", () => {
  it("commits when ?digest= matches body sha256", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const body = Buffer.from("monolithic", "utf8");
    const digest = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
    const res = await app.inject({
      method: "POST",
      url: `/v2/kaiad-agent/blobs/uploads/?digest=${digest}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/octet-stream"
      },
      payload: body
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["docker-content-digest"]).toBe(digest);
    expect(state.blobRows.has(digest)).toBe(true);
  });
});

describe("DELETE upload (cancel)", () => {
  it("removes the session and oid", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const init = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    const uuid = init.headers["docker-upload-uuid"] as string;
    expect(state.uploads.size).toBe(1);
    const del = await app.inject({
      method: "DELETE",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}`,
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    expect(del.statusCode).toBe(204);
    expect(state.uploads.size).toBe(0);
  });
});

describe("GET upload status", () => {
  it("returns Range showing received bytes", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const init = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/",
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    const uuid = init.headers["docker-upload-uuid"] as string;
    await app.inject({
      method: "PATCH",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/octet-stream"
      },
      payload: Buffer.from("abc")
    });
    const status = await app.inject({
      method: "GET",
      url: `/v2/kaiad-agent/blobs/uploads/${uuid}`,
      headers: { authorization: bearerForRepo("kaiad-agent", ["push", "pull"]) }
    });
    expect(status.statusCode).toBe(204);
    expect(status.headers["range"]).toBe("0-2");
  });
});

describe("manifest PUT", () => {
  function bodyAndDigest(json: unknown): { body: Buffer; digest: string } {
    const body = Buffer.from(JSON.stringify(json));
    const digest = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
    return { body, digest };
  }

  it("rejects when a referenced layer blob is missing", async () => {
    const state = newState();
    const app = buildApp(makeFakePool(state));
    const { body } = bodyAndDigest({
      schemaVersion: 2,
      config: { digest: "sha256:" + "c".repeat(64) },
      layers: [{ digest: "sha256:" + "a".repeat(64) }]
    });
    const res = await app.inject({
      method: "PUT",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/vnd.docker.distribution.manifest.v2+json"
      },
      payload: body
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0].code).toBe("MANIFEST_BLOB_UNKNOWN");
  });

  it("stores manifest + upserts tag when all blobs are present", async () => {
    const state = newState();
    const configDigest = "sha256:" + "c".repeat(64);
    const layerDigest = "sha256:" + "a".repeat(64);
    state.blobRows.set(configDigest, { mediaType: null, sizeBytes: 1, contentOid: 1 });
    state.blobRows.set(layerDigest, { mediaType: null, sizeBytes: 2, contentOid: 2 });
    const app = buildApp(makeFakePool(state));

    const { body, digest } = bodyAndDigest({
      schemaVersion: 2,
      config: { digest: configDigest },
      layers: [{ digest: layerDigest }]
    });
    const res = await app.inject({
      method: "PUT",
      url: "/v2/kaiad-agent/manifests/v1",
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/vnd.docker.distribution.manifest.v2+json"
      },
      payload: body
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["docker-content-digest"]).toBe(digest);
    expect(state.manifests.has(digest)).toBe(true);
    expect(state.tags.get("kaiad-agent|v1")).toBe(digest);
  });

  it("does not create a tag when the reference is a digest", async () => {
    const state = newState();
    state.blobRows.set("sha256:" + "c".repeat(64), {
      mediaType: null,
      sizeBytes: 1,
      contentOid: 1
    });
    const app = buildApp(makeFakePool(state));

    const { body, digest } = bodyAndDigest({
      schemaVersion: 2,
      config: { digest: "sha256:" + "c".repeat(64) }
    });
    const res = await app.inject({
      method: "PUT",
      url: `/v2/kaiad-agent/manifests/${digest}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/vnd.docker.distribution.manifest.v2+json"
      },
      payload: body
    });
    expect(res.statusCode).toBe(201);
    expect(state.tags.size).toBe(0);
  });

  it("rejects bad manifest media type with 415", async () => {
    const app = buildApp(makeFakePool(newState()));
    const res = await app.inject({
      method: "PUT",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["push", "pull"]),
        "content-type": "application/json"
      },
      payload: '{"schemaVersion":2}'
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("DELETE manifest", () => {
  it("removes manifest + cascading tags", async () => {
    const state = newState();
    const digest = "sha256:" + "f".repeat(64);
    state.manifests.set(digest, {
      repo: "kaiad-agent",
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      body: Buffer.from("{}"),
      configDigest: null,
      layerDigests: [],
      referencedManifestDigests: []
    });
    state.tags.set("kaiad-agent|latest", digest);
    state.tags.set("kaiad-agent|v1", digest);
    const app = buildApp(makeFakePool(state));

    const res = await app.inject({
      method: "DELETE",
      url: `/v2/kaiad-agent/manifests/${digest}`,
      headers: {
        authorization: bearerForRepo("kaiad-agent", ["delete"])
      }
    });
    expect(res.statusCode).toBe(202);
    expect(state.manifests.has(digest)).toBe(false);
    expect(state.tags.size).toBe(0);
  });

  it("rejects DELETE by tag with 405", async () => {
    const app = buildApp(makeFakePool(newState()));
    const res = await app.inject({
      method: "DELETE",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: { authorization: bearerForRepo("kaiad-agent", ["delete"]) }
    });
    expect(res.statusCode).toBe(405);
  });
});

// General guarantee: identical content pushed to multiple repos shares
// one digest/row (owned by the first writer). Reads, deletes and GC must
// be correct for EVERY repo, not just the first writer. Reproduces the
// build pipeline's `<svc>-image` + `<svc>` double-push for any service.
describe("cross-repo content dedup invariant", () => {
  const digest = "sha256:" + "a7".repeat(32);
  function seedDeduped(state: FakeState) {
    // First writer: voxel-rts-image. Same content later tagged in voxel-rts.
    state.manifests.set(digest, {
      repo: "voxel-rts-image",
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      body: Buffer.from('{"schemaVersion":2}'),
      configDigest: null,
      layerDigests: [],
      referencedManifestDigests: []
    });
    state.tags.set("voxel-rts-image|a916", digest);
    state.tags.set("voxel-rts-image|latest", digest);
    state.tags.set("voxel-rts|a916", digest);
    state.tags.set("voxel-rts|latest", digest);
  }

  it("GET by tag succeeds from the non-first-writer repo (the build bug)", async () => {
    const state = newState();
    seedDeduped(state);
    const app = buildApp(makeFakePool(state));
    const res = await app.inject({
      method: "GET",
      url: "/v2/voxel-rts/manifests/a916",
      headers: { authorization: bearerForRepo("voxel-rts", ["pull"]) }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["docker-content-digest"]).toBe(digest);
  });

  it("GET by digest succeeds when reachable in the repo, 404 when not", async () => {
    const state = newState();
    seedDeduped(state);
    const app = buildApp(makeFakePool(state));
    const ok = await app.inject({
      method: "GET",
      url: `/v2/voxel-rts/manifests/${digest}`,
      headers: { authorization: bearerForRepo("voxel-rts", ["pull"]) }
    });
    expect(ok.statusCode).toBe(200);
    const leak = await app.inject({
      method: "GET",
      url: `/v2/some-unrelated/manifests/${digest}`,
      headers: { authorization: bearerForRepo("some-unrelated", ["pull"]) }
    });
    expect(leak.statusCode).toBe(404); // no cross-repo/tenant disclosure
  });

  it("DELETE from one repo keeps shared content alive for the other", async () => {
    const state = newState();
    seedDeduped(state);
    const app = buildApp(makeFakePool(state));
    const res = await app.inject({
      method: "DELETE",
      url: `/v2/voxel-rts/manifests/${digest}`,
      headers: { authorization: bearerForRepo("voxel-rts", ["delete"]) }
    });
    expect(res.statusCode).toBe(202);
    // voxel-rts tags gone; voxel-rts-image still serves; row survives.
    expect(state.tags.has("voxel-rts|a916")).toBe(false);
    expect(state.tags.has("voxel-rts|latest")).toBe(false);
    expect(state.tags.has("voxel-rts-image|a916")).toBe(true);
    expect(state.manifests.has(digest)).toBe(true);
    const stillThere = await app.inject({
      method: "GET",
      url: "/v2/voxel-rts-image/manifests/a916",
      headers: { authorization: bearerForRepo("voxel-rts-image", ["pull"]) }
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it("DELETE removes the shared row only when the last repo lets go", async () => {
    const state = newState();
    seedDeduped(state);
    const app = buildApp(makeFakePool(state));
    for (const repo of ["voxel-rts", "voxel-rts-image"]) {
      const r = await app.inject({
        method: "DELETE",
        url: `/v2/${repo}/manifests/${digest}`,
        headers: { authorization: bearerForRepo(repo, ["delete"]) }
      });
      expect(r.statusCode).toBe(202);
    }
    expect(state.tags.size).toBe(0);
    expect(state.manifests.has(digest)).toBe(false); // now globally orphaned
  });

  it("DELETE by digest 404s from a repo that doesn't tag it", async () => {
    const state = newState();
    seedDeduped(state);
    const app = buildApp(makeFakePool(state));
    const res = await app.inject({
      method: "DELETE",
      url: `/v2/some-unrelated/manifests/${digest}`,
      headers: { authorization: bearerForRepo("some-unrelated", ["delete"]) }
    });
    expect(res.statusCode).toBe(404);
    expect(state.manifests.has(digest)).toBe(true);
  });
});

describe("DELETE blob", () => {
  it("removes blob row and unlinks oid", async () => {
    const state = newState();
    const digest = "sha256:" + "9".repeat(64);
    state.blobs.set(77, Buffer.from("hello"));
    state.blobRows.set(digest, { mediaType: null, sizeBytes: 5, contentOid: 77 });
    const app = buildApp(makeFakePool(state));

    const res = await app.inject({
      method: "DELETE",
      url: `/v2/kaiad-agent/blobs/${digest}`,
      headers: { authorization: bearerForRepo("kaiad-agent", ["delete"]) }
    });
    expect(res.statusCode).toBe(202);
    expect(state.blobRows.has(digest)).toBe(false);
    expect(state.blobs.has(77)).toBe(false);
  });
});
