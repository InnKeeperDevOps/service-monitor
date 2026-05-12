import { describe, it, expect, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureRegistryAuth,
  signRegistryToken,
  type RegistryAuthConfig
} from "@sm/registry-auth";
import {
  buildAuthChallenge,
  grantAllows,
  verifyRegistryToken,
  type RegistryVerifyOk
} from "../src/registry/auth.js";

let config: RegistryAuthConfig;

beforeAll(async () => {
  // Fresh keypair in a tmp dir per test run — keeps the global cache
  // inside registryAuth.ts pinned to this config for the duration.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kaiad-reg-auth-"));
  config = {
    keyPath: path.join(dir, "key.pem"),
    certPath: path.join(dir, "cert.pem"),
    issuer: "kaiad-test",
    service: "kaiad-registry-test"
  };
  ensureRegistryAuth(config);
});

describe("verifyRegistryToken", () => {
  it("accepts a freshly minted token and exposes its access claim", () => {
    const { token } = signRegistryToken(config, {
      subject: "alice",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    });
    const result = verifyRegistryToken(`Bearer ${token}`, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subject).toBe("alice");
      expect(result.access).toEqual([
        { type: "repository", name: "kaiad-agent", actions: ["pull"] }
      ]);
    }
  });

  it("rejects when Authorization header is missing", () => {
    const result = verifyRegistryToken(undefined, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("missing");
  });

  it("rejects malformed tokens", () => {
    const result = verifyRegistryToken("Bearer not.a.jwt.really", config);
    expect(result.ok).toBe(false);
  });

  it("rejects expired tokens", () => {
    const { token } = signRegistryToken(
      { ...config, ttlSeconds: 1 },
      { subject: "s", access: [] }
    );
    // Future-clock the verifier past the exp window.
    const future = Math.floor(Date.now() / 1000) + 60 * 60;
    const result = verifyRegistryToken(`Bearer ${token}`, config, { nowSec: future });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("expired");
  });

  it("rejects tokens with wrong audience", () => {
    const { token } = signRegistryToken(config, { subject: "s", access: [] });
    const result = verifyRegistryToken(`Bearer ${token}`, config, {
      audience: "wrong-service"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("bad_audience");
  });

  it("rejects when signature has been tampered with", () => {
    const { token } = signRegistryToken(config, { subject: "s", access: [] });
    const parts = token.split(".");
    // Flip a bit in the signature.
    const sig = Buffer.from(parts[2], "base64");
    sig[0] ^= 0x01;
    const tampered = `${parts[0]}.${parts[1]}.${sig.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
    const result = verifyRegistryToken(`Bearer ${tampered}`, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("bad_signature");
  });
});

describe("grantAllows", () => {
  it("matches type + name + action", () => {
    const grant: RegistryVerifyOk = {
      ok: true,
      subject: "s",
      access: [{ type: "repository", name: "kaiad-agent", actions: ["pull"] }]
    };
    expect(
      grantAllows(grant, { type: "repository", name: "kaiad-agent", action: "pull" })
    ).toBe(true);
    expect(
      grantAllows(grant, { type: "repository", name: "kaiad-agent", action: "push" })
    ).toBe(false);
    expect(
      grantAllows(grant, { type: "repository", name: "other", action: "pull" })
    ).toBe(false);
  });

  it("treats '*' as wildcard action", () => {
    const grant: RegistryVerifyOk = {
      ok: true,
      subject: "s",
      access: [{ type: "repository", name: "r", actions: ["*"] }]
    };
    expect(grantAllows(grant, { type: "repository", name: "r", action: "push" })).toBe(true);
  });
});

describe("buildAuthChallenge", () => {
  it("emits a docker-shaped Bearer challenge with scope", () => {
    const c = buildAuthChallenge({
      realm: "https://panel.kaiad.dev/registry/token",
      service: "kaiad-registry",
      scopes: [{ type: "repository", name: "kaiad-agent", action: "pull" }]
    });
    expect(c).toBe(
      'Bearer realm="https://panel.kaiad.dev/registry/token",service="kaiad-registry",scope="repository:kaiad-agent:pull"'
    );
  });

  it("emits no scope when none requested", () => {
    const c = buildAuthChallenge({
      realm: "https://x/registry/token",
      service: "s",
      scopes: []
    });
    expect(c).not.toContain("scope=");
  });
});
