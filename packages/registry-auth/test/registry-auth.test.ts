import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureRegistryAuth,
  signRegistryToken,
  parseScopes,
  filterAllowedActions,
  type RegistryAuthConfig
} from "../src/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regauth-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const config: RegistryAuthConfig = {
  keyPath: path.join(tmp, "key.pem"),
  certPath: path.join(tmp, "cert.pem"),
  issuer: "kaiad-test",
  service: "kaiad-registry",
  ttlSeconds: 300
};

function decodeJwt(token: string) {
  const [h, p, s] = token.split(".");
  const json = (seg: string) =>
    JSON.parse(
      Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
  return { header: json(h), payload: json(p), signingInput: `${h}.${p}`, sig: s };
}

describe("parseScopes", () => {
  it("parses repository scope with multiple actions", () => {
    expect(parseScopes("repository:kaiad-agent:pull,push")).toEqual([
      { type: "repository", name: "kaiad-agent", actions: ["pull", "push"] }
    ]);
  });

  it("keeps colons inside the repo name (host:port/path)", () => {
    expect(parseScopes("repository:127.0.0.1:5000/foo:pull")).toEqual([
      { type: "repository", name: "127.0.0.1:5000/foo", actions: ["pull"] }
    ]);
  });

  it("parses multiple space-separated scopes and skips malformed ones", () => {
    expect(
      parseScopes("repository:a:pull repository:b:push bogus registry:catalog:*")
    ).toEqual([
      { type: "repository", name: "a", actions: ["pull"] },
      { type: "repository", name: "b", actions: ["push"] },
      { type: "registry", name: "catalog", actions: ["*"] }
    ]);
  });

  it("returns [] for empty/undefined", () => {
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe("filterAllowedActions", () => {
  it("keeps only granted actions and drops fully-denied scopes", () => {
    const requested = parseScopes("repository:pub:pull,push repository:priv:pull");
    const filtered = filterAllowedActions(requested, (r) =>
      r.name === "pub" ? r.actions.filter((a) => a === "pull") : []
    );
    expect(filtered).toEqual([
      { type: "repository", name: "pub", actions: ["pull"] }
    ]);
  });
});

describe("ensureRegistryAuth + signRegistryToken", () => {
  it("creates a keypair and signs a verifiable RS256 token", () => {
    const { key, kid } = ensureRegistryAuth(config);
    expect(kid).toBeTruthy();
    expect(fs.existsSync(config.keyPath)).toBe(true);
    expect(fs.existsSync(config.certPath)).toBe(true);

    const access = [
      { type: "repository", name: "kaiad-agent", actions: ["pull"] as const }
    ];
    const { token, expiresInSeconds } = signRegistryToken(config, {
      subject: "anonymous",
      access: access as never
    });
    expect(expiresInSeconds).toBe(300);

    const { header, payload, signingInput, sig } = decodeJwt(token);
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe(kid);
    expect(payload.iss).toBe("kaiad-test");
    expect(payload.sub).toBe("anonymous");
    expect(payload.aud).toBe("kaiad-registry");
    expect(payload.access).toEqual(access);
    expect(payload.exp - payload.iat).toBe(300);

    // Signature must verify against the keypair's public key.
    const pub = crypto.createPublicKey(key);
    const ok = crypto
      .createVerify("RSA-SHA256")
      .update(signingInput)
      .verify(pub, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    expect(ok).toBe(true);
  });

  it("is idempotent for the same keyPath (stable kid)", () => {
    const a = ensureRegistryAuth(config);
    const b = ensureRegistryAuth(config);
    expect(b.kid).toBe(a.kid);
  });
});
