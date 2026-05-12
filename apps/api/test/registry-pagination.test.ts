// Pagination + Link-header tests for /v2/_catalog and /v2/<name>/tags/list.

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
import { parsePagination, registerRegistryRoutes } from "../src/registry/routes.js";

let config: RegistryAuthConfig;

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kaiad-reg-page-"));
  config = {
    keyPath: path.join(dir, "key.pem"),
    certPath: path.join(dir, "cert.pem"),
    issuer: "kaiad-test",
    service: "kaiad-registry-test"
  };
  ensureRegistryAuth(config);
});

function makePool(rows: Record<string, unknown>[][]) {
  const queue = [...rows];
  const exec = async () => ({ rows: queue.shift() ?? [] });
  return {
    query: vi.fn(exec),
    connect: vi.fn(async () => ({ query: vi.fn(exec), release: vi.fn() }))
  } as any;
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

describe("parsePagination (pure)", () => {
  it("returns empty when no query params", () => {
    expect(parsePagination({ query: {} })).toEqual({ limit: undefined, after: undefined });
  });
  it("parses n as a positive integer", () => {
    expect(parsePagination({ query: { n: "25" } }).limit).toBe(25);
  });
  it("ignores non-positive or non-numeric n", () => {
    expect(parsePagination({ query: { n: "0" } }).limit).toBeUndefined();
    expect(parsePagination({ query: { n: "-5" } }).limit).toBeUndefined();
    expect(parsePagination({ query: { n: "abc" } }).limit).toBeUndefined();
  });
  it("caps n at 1000", () => {
    expect(parsePagination({ query: { n: "99999" } }).limit).toBe(1000);
  });
  it("passes through `last` when set", () => {
    expect(parsePagination({ query: { last: "kaiad-agent" } }).after).toBe("kaiad-agent");
  });
  it("treats empty `last` as undefined", () => {
    expect(parsePagination({ query: { last: "" } }).after).toBeUndefined();
  });
});

describe("/v2/_catalog pagination", () => {
  function bearer() {
    const { token } = signRegistryToken(config, {
      subject: "admin",
      access: [{ type: "registry", name: "catalog", actions: ["*"] }]
    });
    return `Bearer ${token}`;
  }

  it("emits Link: rel=next when the page filled", async () => {
    const pool = makePool([[{ repo: "alpha" }, { repo: "beta" }]]);
    const app = buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/v2/_catalog?n=2",
      headers: { authorization: bearer() }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["link"]).toBe('</v2/_catalog?n=2&last=beta>; rel="next"');
  });

  it("omits Link when the page did not fill", async () => {
    const pool = makePool([[{ repo: "alpha" }]]);
    const app = buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/v2/_catalog?n=10",
      headers: { authorization: bearer() }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["link"]).toBeUndefined();
  });

  it("url-encodes the cursor in Link", async () => {
    const pool = makePool([[{ repo: "ns/with slash" }]]);
    const app = buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/v2/_catalog?n=1",
      headers: { authorization: bearer() }
    });
    expect(res.headers["link"]).toContain("ns%2Fwith%20slash");
  });
});

describe("/v2/<name>/tags/list pagination", () => {
  function bearer(repo: string) {
    const { token } = signRegistryToken(config, {
      subject: "u",
      access: [{ type: "repository", name: repo, actions: ["pull"] }]
    });
    return `Bearer ${token}`;
  }

  it("emits Link when filled, points at the same repo", async () => {
    const pool = makePool([
      [
        { repo: "kaiad-agent", tag: "v1", manifest_digest: "sha256:a", updated_at: "x" },
        { repo: "kaiad-agent", tag: "v2", manifest_digest: "sha256:b", updated_at: "x" }
      ]
    ]);
    const app = buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/tags/list?n=2",
      headers: { authorization: bearer("kaiad-agent") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["link"]).toBe(
      '</v2/kaiad-agent/tags/list?n=2&last=v2>; rel="next"'
    );
  });
});
