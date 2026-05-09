// Token-auth service for Kaiad's built-in OCI registry.
//
// The registry container runs in token-auth mode and challenges clients
// with `WWW-Authenticate: Bearer realm=https://panel.dev.kaiad.dev/registry/token,…`.
// Clients then call /registry/token here, present a credential via Basic
// auth, and receive a JWT scoped to the access they requested. The
// registry validates the JWT signature against the public cert it has
// in its `rootcertbundle`.
//
// JWT format (per the docker/distribution token spec):
//   header  { typ: "JWT", alg: "RS256", kid: <libtrust key id> }
//   payload { iss, sub, aud, exp, nbf, iat, jti, access: [...] }
//
// The `kid` is a libtrust-format identifier (Docker's quirky pre-JWK
// key id): SHA-256 of the SubjectPublicKeyInfo DER, truncated to 30
// bytes, base32-encoded, then split into 12 4-character groups joined
// by colons (e.g. "AAAA:BBBB:CCCC:..."). The registry computes the
// same id from each cert in `rootcertbundle` and matches by that.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RegistryAccessAction = "pull" | "push" | "delete" | "*";

export type RegistryAccess = {
  type: string; // "repository"
  name: string; // "kaiad-agent"
  actions: RegistryAccessAction[];
};

export type RegistryAuthConfig = {
  /** Path to the RSA private key (PEM, PKCS#8). Created on first boot. */
  keyPath: string;
  /** Path to the X.509 cert (PEM). Created on first boot. */
  certPath: string;
  /** `iss` claim. Must match REGISTRY_AUTH_TOKEN_ISSUER. */
  issuer: string;
  /** `aud` claim. Must match REGISTRY_AUTH_TOKEN_SERVICE. */
  service: string;
  /** Token lifetime in seconds. */
  ttlSeconds?: number;
};

const DEFAULT_TTL = 5 * 60;

let cached: { config: RegistryAuthConfig; key: crypto.KeyObject; kid: string } | null = null;

/** Lazily load (and create on first call) the keypair + cert. */
export function ensureRegistryAuth(config: RegistryAuthConfig): { key: crypto.KeyObject; kid: string } {
  if (cached && cached.config.keyPath === config.keyPath) {
    return { key: cached.key, kid: cached.kid };
  }
  fs.mkdirSync(path.dirname(config.keyPath), { recursive: true });
  fs.mkdirSync(path.dirname(config.certPath), { recursive: true });

  let keyPem: string;
  let certPem: string;
  if (fs.existsSync(config.keyPath) && fs.existsSync(config.certPath)) {
    keyPem = fs.readFileSync(config.keyPath, "utf8");
    certPem = fs.readFileSync(config.certPath, "utf8");
  } else {
    const generated = generateSelfSignedRSA(config.issuer);
    fs.writeFileSync(config.keyPath, generated.keyPem, { mode: 0o600 });
    fs.writeFileSync(config.certPath, generated.certPem, { mode: 0o644 });
    keyPem = generated.keyPem;
    certPem = generated.certPem;
  }

  const key = crypto.createPrivateKey(keyPem);
  const cert = new crypto.X509Certificate(certPem);
  const publicKey = cert.publicKey;
  const kid = libtrustKid(publicKey);
  cached = { config, key, kid };
  return { key, kid };
}

/** Sign a docker-registry-shaped JWT with the cached keypair. */
export function signRegistryToken(
  config: RegistryAuthConfig,
  args: { subject: string; access: RegistryAccess[] }
): { token: string; expiresInSeconds: number; issuedAt: string } {
  const { key, kid } = ensureRegistryAuth(config);
  const ttl = config.ttlSeconds ?? DEFAULT_TTL;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "RS256", kid };
  const payload = {
    iss: config.issuer,
    sub: args.subject,
    aud: config.service,
    iat: now,
    nbf: now,
    exp: now + ttl,
    jti: crypto.randomBytes(12).toString("hex"),
    access: args.access
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(key);
  const token = `${signingInput}.${b64url(sig)}`;
  return {
    token,
    expiresInSeconds: ttl,
    issuedAt: new Date(now * 1000).toISOString()
  };
}

/** Compute the libtrust key id of a public key. */
export function libtrustKid(publicKey: crypto.KeyObject): string {
  // SPKI = SubjectPublicKeyInfo, the DER form distribution's libtrust
  // hashes. Node's KeyObject.export({type:"spki",format:"der"}) gives
  // exactly that.
  const der = publicKey.export({ type: "spki", format: "der" });
  const sha = crypto.createHash("sha256").update(der).digest();
  const truncated = sha.subarray(0, 30); // 240 bits
  // RFC 4648 base32 (uppercase). Node has no base32 built-in; do it manually.
  const b32 = base32Encode(truncated);
  // Split into 12 groups of 4, separated by colons.
  return b32.match(/.{1,4}/g)!.join(":");
}

/** RFC 4648 base32 (uppercase, no padding) for an exact-multiple-of-5 buffer. */
function base32Encode(buf: Buffer): string {
  // 30 bytes = 240 bits = 48 base32 chars exactly, no padding needed.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Parse a docker registry scope string. Examples:
 *   repository:kaiad-agent:pull
 *   repository:kaiad-agent:pull,push
 *   repository(plugin):kaiad-agent:pull
 * The colon-separated form is `type[(class)]:name:actions`. Multiple
 * scopes may be space-separated in a single ?scope= param.
 */
export function parseScopes(scopeParam: string | undefined): RegistryAccess[] {
  if (!scopeParam) return [];
  const items = scopeParam.split(/\s+/).filter(Boolean);
  const out: RegistryAccess[] = [];
  for (const item of items) {
    const parts = item.split(":");
    if (parts.length < 3) continue;
    const type = parts[0].split("(")[0];
    const name = parts.slice(1, -1).join(":"); // names can contain colons
    const actions = parts[parts.length - 1].split(",").filter(Boolean) as RegistryAccessAction[];
    if (!type || !name || actions.length === 0) continue;
    out.push({ type, name, actions });
  }
  return out;
}

/** Filter actions a caller is allowed to receive. */
export function filterAllowedActions(
  requested: RegistryAccess[],
  allowed: (req: RegistryAccess) => RegistryAccessAction[]
): RegistryAccess[] {
  const out: RegistryAccess[] = [];
  for (const req of requested) {
    const grant = allowed(req);
    if (grant.length > 0) {
      out.push({ type: req.type, name: req.name, actions: grant });
    }
  }
  return out;
}

// --- self-signed cert generation ---

/**
 * Generate an RSA-2048 keypair + self-signed X.509 cert. The registry's
 * `rootcertbundle` only cares about the public key inside the cert
 * (libtrust kid → match → verify); cert subject/issuer are not
 * validated. We still set a sensible CN so `openssl x509 -text` is
 * informative when an operator inspects the file.
 */
function generateSelfSignedRSA(commonName: string): { keyPem: string; certPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  // Hand-roll a minimal self-signed X.509 v3 cert because Node's stdlib
  // doesn't expose a cert builder. We use the X509Certificate(buffer)
  // round-trip path: build the TBS DER, sign it, wrap with the signature
  // — same shape openssl req would produce.
  const certPem = buildSelfSignedCert(privateKey, publicKey, commonName);
  return { keyPem, certPem };
}

function buildSelfSignedCert(
  privateKey: crypto.KeyObject,
  publicKey: crypto.KeyObject,
  commonName: string
): string {
  // Use Node's `crypto` to manufacture a v1 cert via the X509Certificate
  // constructor. The simplest path: produce DER for a CertificationRequest,
  // self-sign it, and re-emit as Certificate. But Node doesn't ship a CSR
  // signer either. So we hand-build TBSCertificate ASN.1.
  //
  // Layout (minimal v1 cert):
  //   Certificate ::= SEQUENCE {
  //     tbsCertificate         TBSCertificate,
  //     signatureAlgorithm     AlgorithmIdentifier,
  //     signature              BIT STRING
  //   }
  //   TBSCertificate ::= SEQUENCE {
  //     version           [0] EXPLICIT INTEGER DEFAULT v1 (omitted)
  //     serialNumber      INTEGER
  //     signature         AlgorithmIdentifier
  //     issuer            Name
  //     validity          Validity
  //     subject           Name
  //     subjectPublicKeyInfo SubjectPublicKeyInfo
  //   }
  // sha256WithRSAEncryption OID = 1.2.840.113549.1.1.11

  const sha256RsaOid = encodeAlgorithmIdentifierSha256RSA();
  const issuer = encodeNameCN(commonName);
  const subject = issuer;
  const validity = encodeValidityYears(10);
  const serial = asn1Integer(crypto.randomBytes(16));
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const tbsBody = Buffer.concat([
    serial,
    sha256RsaOid,
    issuer,
    validity,
    subject,
    spki
  ]);
  const tbs = asn1Sequence(tbsBody);
  const sig = crypto.createSign("RSA-SHA256").update(tbs).sign(privateKey);
  const sigBitString = asn1BitString(sig);
  const cert = asn1Sequence(Buffer.concat([tbs, sha256RsaOid, sigBitString]));
  const b64 = cert.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// --- ASN.1/DER helpers ---

function asn1Length(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function asn1Tag(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), asn1Length(body.length), body]);
}

function asn1Sequence(body: Buffer): Buffer {
  return asn1Tag(0x30, body);
}

function asn1Integer(value: Buffer): Buffer {
  // Strip leading zeros but keep one if high bit is set (positive INT).
  let v = value;
  while (v.length > 1 && v[0] === 0 && (v[1] & 0x80) === 0) v = v.subarray(1);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return asn1Tag(0x02, v);
}

function asn1BitString(body: Buffer): Buffer {
  return asn1Tag(0x03, Buffer.concat([Buffer.from([0]), body])); // 0 unused bits
}

function asn1Oid(parts: number[]): Buffer {
  const first = parts[0] * 40 + parts[1];
  const rest = parts.slice(2);
  const out: number[] = [first];
  for (const p of rest) {
    if (p < 128) out.push(p);
    else {
      const bytes: number[] = [];
      let v = p;
      while (v > 0) {
        bytes.unshift(v & 0x7f);
        v >>>= 7;
      }
      for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
      out.push(...bytes);
    }
  }
  return asn1Tag(0x06, Buffer.from(out));
}

function asn1Null(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function encodeAlgorithmIdentifierSha256RSA(): Buffer {
  // sha256WithRSAEncryption OID 1.2.840.113549.1.1.11
  const oid = asn1Oid([1, 2, 840, 113549, 1, 1, 11]);
  return asn1Sequence(Buffer.concat([oid, asn1Null()]));
}

function asn1UTF8String(s: string): Buffer {
  return asn1Tag(0x0c, Buffer.from(s, "utf8"));
}

function encodeNameCN(cn: string): Buffer {
  // Name ::= SEQUENCE OF RelativeDistinguishedName
  // RDN ::= SET OF AttributeTypeAndValue
  // ATV ::= SEQUENCE { type OID, value ANY }
  // CN OID = 2.5.4.3
  const oid = asn1Oid([2, 5, 4, 3]);
  const atv = asn1Sequence(Buffer.concat([oid, asn1UTF8String(cn)]));
  const rdn = asn1Tag(0x31, atv);
  return asn1Sequence(rdn);
}

function asn1UtcTime(date: Date): Buffer {
  const y = date.getUTCFullYear() % 100;
  const pad = (n: number) => String(n).padStart(2, "0");
  const s =
    `${pad(y)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return asn1Tag(0x17, Buffer.from(s, "ascii"));
}

function encodeValidityYears(years: number): Buffer {
  const start = new Date();
  const end = new Date(start.getTime() + years * 365 * 24 * 60 * 60 * 1000);
  return asn1Sequence(Buffer.concat([asn1UtcTime(start), asn1UtcTime(end)]));
}
