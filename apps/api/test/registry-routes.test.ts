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
import { parseRangeHeader } from "../src/registry/routes.js";

let config: RegistryAuthConfig;

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kaiad-reg-routes-"));
  config = {
    keyPath: path.join(dir, "key.pem"),
    certPath: path.join(dir, "cert.pem"),
    issuer: "kaiad-test",
    service: "kaiad-registry-test"
  };
  ensureRegistryAuth(config);
});

type CannedResponse = { rows: Record<string, unknown>[] };

/**
 * Construct a Pool stub whose .query() walks through `responses` in
 * order. Each call shifts one response off. .connect() returns a client
 * doing the same — adequate for non-blob handler tests.
 */
function makePool(responses: CannedResponse[]): any {
  const queue = [...responses];
  const next = () => queue.shift() ?? { rows: [] };
  const client = { query: vi.fn(async () => next()), release: vi.fn() };
  return {
    query: vi.fn(async () => next()),
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

function bearerFor(args: Parameters<typeof signRegistryToken>[1]): string {
  const { token } = signRegistryToken(config, args);
  return `Bearer ${token}`;
}

describe("registry routes: ping", () => {
  it("/v2/ returns 401 with Bearer challenge when no token", async () => {
    const app = buildApp(makePool([]));
    const res = await app.inject({ method: "GET", url: "/v2/" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer realm=");
    expect(res.headers["www-authenticate"]).toContain(
      'service="kaiad-registry-test"'
    );
  });

  it("/v2/ returns 200 with valid bearer", async () => {
    const app = buildApp(makePool([]));
    const auth = bearerFor({ subject: "alice", access: [] });
    const res = await app.inject({
      method: "GET",
      url: "/v2/",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["docker-distribution-api-version"]).toBe("registry/2.0");
  });
});

describe("registry routes: catalog", () => {
  it("returns repositories for an admin-scoped token", async () => {
    const pool = makePool([{ rows: [{ repo: "kaiad-agent" }, { repo: "library/alpine" }] }]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "admin",
      access: [{ type: "registry", name: "catalog", actions: ["*"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/_catalog",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      repositories: ["kaiad-agent", "library/alpine"]
    });
  });

  it("returns 403 when token lacks catalog scope", async () => {
    const app = buildApp(makePool([]));
    const auth = bearerFor({
      subject: "user",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/_catalog",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("registry routes: tags list", () => {
  it("returns tags for a repo with pull scope", async () => {
    const pool = makePool([
      {
        rows: [
          { repo: "kaiad-agent", tag: "v1", manifest_digest: "sha256:a", updated_at: "2026-01-01" },
          { repo: "kaiad-agent", tag: "v2", manifest_digest: "sha256:b", updated_at: "2026-01-02" }
        ]
      }
    ]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/tags/list",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      name: "kaiad-agent",
      tags: ["v1", "v2"]
    });
  });

  it("returns tags for repo names with slashes", async () => {
    const pool = makePool([{ rows: [] }]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "library/alpine", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/library/alpine/tags/list",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("library/alpine");
  });
});

describe("registry routes: manifests", () => {
  it("fetches a manifest by tag", async () => {
    const body = Buffer.from('{"schemaVersion":2}');
    const pool = makePool([
      {
        rows: [
          {
            digest: "sha256:m",
            repo: "kaiad-agent",
            media_type: "application/vnd.docker.distribution.manifest.v2+json",
            body,
            size_bytes: body.length,
            config_digest: null,
            layer_digests: [],
            referenced_manifest_digests: [],
            created_at: "2026-01-01"
          }
        ]
      }
    ]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["docker-content-digest"]).toBe("sha256:m");
    expect(res.headers["content-type"]).toBe(
      "application/vnd.docker.distribution.manifest.v2+json"
    );
    expect(res.rawPayload).toEqual(body);
  });

  it("serves a tag whose manifest is deduped under another repo (cross-repo content)", async () => {
    // Build pipeline pushes identical content to `voxel-rts-image` then
    // `voxel-rts`; the manifest row is owned by the first repo. A tag
    // pull from `voxel-rts` must still succeed — getRegistryManifestByTag
    // is already scoped by t.repo, so manifest.repo must not gate it.
    const body = Buffer.from('{"schemaVersion":2}');
    const pool = makePool([
      {
        rows: [
          {
            digest: "sha256:7313",
            repo: "voxel-rts-image", // first writer owns the row
            media_type: "application/vnd.docker.distribution.manifest.v2+json",
            body,
            size_bytes: body.length,
            config_digest: null,
            layer_digests: [],
            referenced_manifest_digests: [],
            created_at: "2026-05-17"
          }
        ]
      }
    ]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "voxel-rts", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/voxel-rts/manifests/a916e292df17e79e09b004ba626513c58a9ee274",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["docker-content-digest"]).toBe("sha256:7313");
    expect(res.rawPayload).toEqual(body);
  });

  it("HEAD returns headers without body", async () => {
    const body = Buffer.from('{"schemaVersion":2}');
    const pool = makePool([
      {
        rows: [
          {
            digest: "sha256:m",
            repo: "kaiad-agent",
            media_type: "application/vnd.docker.distribution.manifest.v2+json",
            body,
            size_bytes: body.length,
            config_digest: null,
            layer_digests: [],
            referenced_manifest_digests: [],
            created_at: "2026-01-01"
          }
        ]
      }
    ]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "HEAD",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["content-length"]).toBe(String(body.length));
  });

  it("returns 404 for missing manifest", async () => {
    const pool = makePool([{ rows: [] }]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/manifests/v9",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(404);
    const err = JSON.parse(res.body);
    expect(err.errors[0].code).toBe("MANIFEST_UNKNOWN");
  });
});

describe("registry routes: blob (HEAD path, no streaming)", () => {
  it("rejects invalid digest", async () => {
    const app = buildApp(makePool([]));
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "HEAD",
      url: "/v2/kaiad-agent/blobs/sha256:not-hex",
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(400);
  });

  it("HEAD returns 200 with size + digest when blob exists", async () => {
    const digest = "sha256:" + "a".repeat(64);
    const pool = makePool([
      {
        rows: [
          {
            digest,
            media_type: "application/octet-stream",
            size_bytes: 1234,
            content_oid: 42,
            created_at: "2026-01-01"
          }
        ]
      }
    ]);
    const app = buildApp(pool);
    const auth = bearerFor({
      subject: "u",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const res = await app.inject({
      method: "HEAD",
      url: `/v2/kaiad-agent/blobs/${digest}`,
      headers: { authorization: auth }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["docker-content-digest"]).toBe(digest);
    expect(res.headers["content-length"]).toBe("1234");
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });
});

describe("write-path auth", () => {
  it("PUT manifest returns 403 when token lacks push scope", async () => {
    const app = buildApp(makePool([]));
    const res = await app.inject({
      method: "PUT",
      url: "/v2/kaiad-agent/manifests/latest",
      headers: {
        authorization: bearerFor({
          subject: "u",
          access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
        }),
        "content-type": "application/vnd.docker.distribution.manifest.v2+json"
      },
      payload: '{"schemaVersion":2,"config":{"digest":"sha256:000"}}'
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).errors[0].code).toBe("DENIED");
  });
});

describe("parseRangeHeader", () => {
  it("returns undefined for no header", () => {
    expect(parseRangeHeader(undefined, 100)).toBeUndefined();
  });
  it("parses bytes=0-99", () => {
    expect(parseRangeHeader("bytes=0-99", 100)).toEqual({ start: 0, end: 99 });
  });
  it("parses bytes=10- as open-ended-to-end", () => {
    expect(parseRangeHeader("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  });
  it("parses bytes=-20 as suffix range", () => {
    expect(parseRangeHeader("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
  });
  it("rejects negative starts", () => {
    expect(parseRangeHeader("bytes=-0", 100)).toBe("invalid");
  });
  it("rejects starts past size", () => {
    expect(parseRangeHeader("bytes=200-", 100)).toBe("invalid");
  });
  it("rejects reversed ranges", () => {
    expect(parseRangeHeader("bytes=50-10", 100)).toBe("invalid");
  });
});
