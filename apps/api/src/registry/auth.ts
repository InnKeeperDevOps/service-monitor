// Verifies bearer tokens issued by /registry/token. Mirrors what the
// registry:2 sidecar does when REGISTRY_AUTH_TOKEN_* is set — same JWT
// shape, same key, same access claim semantics.
//
// Returns the parsed grant on success or a `kind`-tagged rejection on
// failure. Handler code shapes the rejection into an OCI-spec error
// body (errors[].code = "UNAUTHORIZED" etc.) + WWW-Authenticate header.

import crypto from "node:crypto";
import {
  ensureRegistryAuth,
  type RegistryAccess,
  type RegistryAccessAction,
  type RegistryAuthConfig
} from "@sm/registry-auth";

export type RegistryVerifyOk = {
  ok: true;
  subject: string;
  access: RegistryAccess[];
};

export type RegistryVerifyErr = {
  ok: false;
  kind:
    | "missing"
    | "malformed"
    | "bad_signature"
    | "bad_issuer"
    | "bad_audience"
    | "expired"
    | "not_yet_valid"
    | "bad_kid";
  message: string;
};

export type RegistryVerifyResult = RegistryVerifyOk | RegistryVerifyErr;

type JwtHeader = { typ?: string; alg?: string; kid?: string };
type JwtPayload = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  iat?: number;
  nbf?: number;
  exp?: number;
  access?: RegistryAccess[];
};

function b64urlDecode(s: string): Buffer {
  // Padding: base64url drops trailing '='; restore by length % 4.
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(b64, "base64");
}

function parseAud(aud: JwtPayload["aud"], expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

/**
 * Verify a bearer token sent on an OCI registry request.
 *
 * `authHeader` is the raw `Authorization` header value, e.g. `Bearer eyJ…`.
 * `audience` is what the request's *Service* should match — usually
 * `registryAuthConfig.service`, but the `/registry/token` minter lets
 * callers pass `service=<x>` so we accept either the configured default
 * or the audience the caller asked for. Pass the matching value here.
 *
 * `nowSec` is a test seam; production callers omit it.
 */
export function verifyRegistryToken(
  authHeader: string | undefined,
  config: RegistryAuthConfig,
  options: { audience?: string; nowSec?: number } = {}
): RegistryVerifyResult {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, kind: "missing", message: "Bearer token required" };
  }
  const token = authHeader.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, kind: "malformed", message: "Token must have 3 parts" };
  }

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, kind: "malformed", message: "Token header/payload not JSON" };
  }
  if (header.alg !== "RS256") {
    return { ok: false, kind: "malformed", message: `Unexpected alg: ${header.alg}` };
  }

  const sig = b64urlDecode(parts[2]);
  const signingInput = `${parts[0]}.${parts[1]}`;

  let kid: string;
  let publicKey: crypto.KeyObject;
  try {
    const cached = ensureRegistryAuth(config);
    kid = cached.kid;
    publicKey = crypto.createPublicKey(cached.key);
  } catch (err) {
    return {
      ok: false,
      kind: "bad_signature",
      message: `Registry signing key unavailable: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  if (header.kid && header.kid !== kid) {
    return { ok: false, kind: "bad_kid", message: "Unknown key id" };
  }

  const verified = crypto
    .createVerify("RSA-SHA256")
    .update(signingInput)
    .verify(publicKey, sig);
  if (!verified) {
    return { ok: false, kind: "bad_signature", message: "Signature mismatch" };
  }

  if (payload.iss !== config.issuer) {
    return { ok: false, kind: "bad_issuer", message: `Unexpected iss: ${payload.iss}` };
  }
  const expectedAud = options.audience ?? config.service;
  if (!parseAud(payload.aud, expectedAud)) {
    return { ok: false, kind: "bad_audience", message: "Unexpected aud" };
  }

  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (payload.nbf !== undefined && now < payload.nbf) {
    return { ok: false, kind: "not_yet_valid", message: "Token not yet valid" };
  }
  if (payload.exp !== undefined && now >= payload.exp) {
    return { ok: false, kind: "expired", message: "Token expired" };
  }

  return {
    ok: true,
    subject: payload.sub ?? "anonymous",
    access: Array.isArray(payload.access) ? payload.access : []
  };
}

// ─── Authorization helpers (used by route handlers) ────────────────────

export type RequiredScope = {
  type: "repository" | "registry";
  name: string;
  action: RegistryAccessAction;
};

/** Does this grant include the requested action on the named repo? */
export function grantAllows(grant: RegistryVerifyOk, need: RequiredScope): boolean {
  for (const a of grant.access) {
    if (a.type !== need.type) continue;
    if (a.name !== need.name) continue;
    if (a.actions.includes(need.action) || a.actions.includes("*")) return true;
  }
  return false;
}

/**
 * Build the WWW-Authenticate challenge that drives the docker client to
 * fetch a token from /registry/token. `scopes` is what the request would
 * need; we tell the client to ask for those.
 */
export function buildAuthChallenge(args: {
  realm: string;
  service: string;
  scopes: RequiredScope[];
}): string {
  const parts = [`realm="${args.realm}"`, `service="${args.service}"`];
  for (const s of args.scopes) {
    parts.push(`scope="${s.type}:${s.name}:${s.action}"`);
  }
  return `Bearer ${parts.join(",")}`;
}
