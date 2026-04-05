import crypto from "node:crypto";

export type OAuthProviderConfig = {
  id: string;
  provider: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
};

export type OIDCProviderConfig = {
  id: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

export type OIDCDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOOPBACK_V4 = ((127 << 24) | 1) >>> 0;
const METADATA_V4 = ((169 << 24) | (254 << 16) | (169 << 8) | 254) >>> 0;
const PRIVATE_V4_RANGES: Array<{ base: number; mask: number }> = [
  { base: (10 << 24) >>> 0, mask: (0xff << 24) >>> 0 },
  { base: ((172 << 24) | (16 << 16)) >>> 0, mask: (0xfff0 << 16) >>> 0 },
  { base: ((192 << 24) | (168 << 16)) >>> 0, mask: (0xffff << 16) >>> 0 }
];

function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  const ip = ipToNumber(lower);
  if (ip === null) {
    return false;
  }
  if (ip === LOOPBACK_V4 || ip === METADATA_V4 || (ip >>> 24) === 127) {
    return true;
  }
  return PRIVATE_V4_RANGES.some((range) => ((ip & range.mask) >>> 0) === range.base);
}

function assertSafeOutboundUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http(s)`);
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new Error(`${label} targets a private or blocked host`);
  }
}

async function fetchWithProtectedRedirects(
  url: string,
  init: RequestInit | undefined,
  label: string,
  fetchFn: FetchLike = fetch
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    assertSafeOutboundUrl(currentUrl, label);
    const response = await fetchFn(currentUrl, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }
    if (hop === MAX_REDIRECT_HOPS) {
      throw new Error(`${label} exceeded redirect limit`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error(`${label} exceeded redirect limit`);
}

export function buildAuthorizeUrl(
  provider: OAuthProviderConfig,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    state,
    scope: provider.scopes.join(" "),
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  provider: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  fetchFn: FetchLike = fetch
): Promise<{ accessToken: string; tokenType: string; expiresIn?: number }> {
  assertSafeOutboundUrl(provider.tokenUrl, "OAuth token URL");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });

  const res = await fetchWithProtectedRedirects(
    provider.tokenUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString()
    },
    "OAuth token URL",
    fetchFn
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: String(json.access_token ?? ""),
    tokenType: String(json.token_type ?? "bearer"),
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : undefined,
  };
}

export async function fetchUserInfo(
  provider: OAuthProviderConfig,
  accessToken: string,
  fetchFn: FetchLike = fetch
): Promise<{ email: string; name?: string; sub: string }> {
  assertSafeOutboundUrl(provider.userInfoUrl, "OAuth userinfo URL");
  const res = await fetchWithProtectedRedirects(
    provider.userInfoUrl,
    {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
    },
    "OAuth userinfo URL",
    fetchFn
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`UserInfo request failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return {
    email: String(json.email ?? ""),
    name: typeof json.name === "string" ? json.name : undefined,
    sub: String(json.sub ?? json.id ?? ""),
  };
}

export async function discoverOIDC(issuerUrl: string, fetchFn: FetchLike = fetch): Promise<OIDCDiscovery> {
  const url = `${issuerUrl.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  assertSafeOutboundUrl(url, "OIDC discovery URL");
  const res = await fetchWithProtectedRedirects(
    url,
    { headers: { Accept: "application/json" } },
    "OIDC discovery URL",
    fetchFn
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OIDC discovery failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return {
    authorization_endpoint: String(json.authorization_endpoint ?? ""),
    token_endpoint: String(json.token_endpoint ?? ""),
    userinfo_endpoint: String(json.userinfo_endpoint ?? ""),
  };
}

export function buildOAuthProviderFromOIDC(
  oidc: OIDCProviderConfig,
  discovery: OIDCDiscovery
): OAuthProviderConfig {
  return {
    id: oidc.id,
    provider: "oidc",
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    authorizeUrl: discovery.authorization_endpoint,
    tokenUrl: discovery.token_endpoint,
    userInfoUrl: discovery.userinfo_endpoint,
    scopes: oidc.scopes,
  };
}

// ---------------------------------------------------------------------------
// In-memory provider store (v1 – no DB queries)
// ---------------------------------------------------------------------------

export type ProviderListEntry = { id: string; provider: string; name: string };

let oauthProviders: Map<string, OAuthProviderConfig> = new Map();
let pendingOAuthStates: Map<string, { providerId: string; createdAt: number }> = new Map();

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function __resetOAuthStoreForTests(): void {
  oauthProviders = new Map();
  pendingOAuthStates = new Map();
}

export function addOAuthProvider(cfg: OAuthProviderConfig): void {
  assertSafeOutboundUrl(cfg.authorizeUrl, "OAuth authorize URL");
  assertSafeOutboundUrl(cfg.tokenUrl, "OAuth token URL");
  assertSafeOutboundUrl(cfg.userInfoUrl, "OAuth userinfo URL");
  oauthProviders.set(cfg.id, cfg);
}

export function getOAuthProvider(id: string): OAuthProviderConfig | undefined {
  return oauthProviders.get(id);
}

export function listProviders(): ProviderListEntry[] {
  return [...oauthProviders.values()].map((p) => ({
    id: p.id,
    provider: p.provider,
    name: p.provider.charAt(0).toUpperCase() + p.provider.slice(1),
  }));
}

export function generateState(providerId: string): string {
  const state = crypto.randomBytes(24).toString("hex");
  pendingOAuthStates.set(state, { providerId, createdAt: Date.now() });
  return state;
}

export function consumeState(state: string): string | null {
  const entry = pendingOAuthStates.get(state);
  if (!entry) return null;
  pendingOAuthStates.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry.providerId;
}

export function seedGoogleProviderFromEnv(): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) return;
  addOAuthProvider({
    id: "google",
    provider: "google",
    clientId,
    clientSecret: clientSecret ?? "",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
  });
}
