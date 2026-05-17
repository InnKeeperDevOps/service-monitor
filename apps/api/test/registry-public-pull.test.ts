import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// The /registry/token minter must hand back an anonymous, pull-only
// token for the default-public `kaiad-agent` repo (no Basic auth), so
// `<host>/kaiad-agent:latest` is pullable out of the box. Everything
// else still requires credentials.

const app = buildServer();

function decodeAccess(jwt: string): Array<{ type: string; name: string; actions: string[] }> {
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  );
  return payload.access ?? [];
}

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("registry public pull (kaiad-agent)", () => {
  it("issues an anonymous pull-only token for kaiad-agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/registry/token?service=kaiad-registry&scope=repository:kaiad-agent:pull"
    });
    expect(res.statusCode).toBe(200);
    const token = res.json().token as string;
    expect(token).toBeTruthy();
    expect(decodeAccess(token)).toEqual([
      { type: "repository", name: "kaiad-agent", actions: ["pull"] }
    ]);
  });

  it("does not grant anonymous push on kaiad-agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/registry/token?service=kaiad-registry&scope=repository:kaiad-agent:push,pull"
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not grant anonymous pull on a non-public repo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/registry/token?service=kaiad-registry&scope=repository:some-tenant-app:pull"
    });
    expect(res.statusCode).toBe(401);
  });

  it("denies a mixed scope unless every repo is public", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/registry/token?service=kaiad-registry&scope=repository:kaiad-agent:pull repository:other:pull"
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("anonymous /v2 pull (no bearer token)", () => {
  // No DATABASE_URL in tests, so registry handlers 503 once auth passes.
  // The point: a public repo must NOT be rejected at the auth layer
  // (401) when no token is presented; a private one must be.

  it("does not 401 a tokenless manifest pull for a forced-public repo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v2/kaiad-agent/manifests/latest"
    });
    expect(res.statusCode).not.toBe(401);
    expect([404, 503]).toContain(res.statusCode);
  });

  it("does not 401 a tokenless blob/tags pull for a forced-public repo", async () => {
    const tags = await app.inject({
      method: "GET",
      url: "/v2/kaiad-operator/tags/list"
    });
    expect(tags.statusCode).not.toBe(401);
    expect([404, 503]).toContain(tags.statusCode);
  });

  it("still 401s a tokenless pull for a non-public repo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v2/some-private-app/manifests/latest"
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeTruthy();
  });

  it("still 401s a tokenless push attempt on a public repo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v2/kaiad-agent/blobs/uploads/"
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("registry visibility endpoint", () => {
  it("refuses to make kaiad-agent private (forced public)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/registry/repositories/kaiad-agent/visibility",
      headers: { authorization: "Bearer dev-token" },
      payload: { public: false }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("FORCED_PUBLIC");
  });

  it("requires an admin session", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/registry/repositories/some-app/visibility",
      payload: { public: true }
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-boolean body", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/registry/repositories/some-app/visibility",
      headers: { authorization: "Bearer dev-token" },
      payload: { public: "yes" }
    });
    expect(res.statusCode).toBe(400);
  });
});
