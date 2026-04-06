import crypto from "node:crypto";
import { assertSafeOutboundUrl, fetchWithProtectedRedirects } from "./ssrf-fetch.js";

export type InstallationTokenRequest = {
  appId: number;
  privateKey: string;
  installationId: number;
};

export type InstallationTokenResult = {
  token: string;
  expiresAt: string;
};

export type InstallationMetadataResult = {
  installationId: number;
  accountLogin: string;
  appId: number;
};

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Creates a GitHub App JWT for authenticating as the app itself.
 * Valid for up to 10 minutes per GitHub's requirements.
 */
export function createAppJwt(appId: number, privateKey: string, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 600,
        iss: String(appId)
      })
    )
  );
  const signable = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signable), privateKey);
  return `${signable}.${base64url(signature)}`;
}

/**
 * Exchanges a GitHub App JWT for an installation access token.
 * In production this calls GitHub's REST API; accepts a `fetch` override for testing.
 */
export async function createInstallationToken(
  req: InstallationTokenRequest,
  opts?: { fetch?: typeof globalThis.fetch; apiBase?: string }
): Promise<InstallationTokenResult> {
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const apiBase = opts?.apiBase ?? "https://api.github.com";
  assertSafeOutboundUrl(apiBase, "GitHub API base URL");

  const jwt = createAppJwt(req.appId, req.privateKey);

  const response = await fetchWithProtectedRedirects(
    `${apiBase}/app/installations/${req.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    },
    "GitHub installation token endpoint",
    fetchFn
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GitHub installation token exchange failed: ${response.status} ${response.statusText} — ${body}`
    );
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

/**
 * Loads installation metadata (account login + app id) for a GitHub App installation.
 */
export async function getInstallationMetadata(
  req: InstallationTokenRequest,
  opts?: { fetch?: typeof globalThis.fetch; apiBase?: string }
): Promise<InstallationMetadataResult> {
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const apiBase = opts?.apiBase ?? "https://api.github.com";
  assertSafeOutboundUrl(apiBase, "GitHub API base URL");

  const jwt = createAppJwt(req.appId, req.privateKey);
  const response = await fetchWithProtectedRedirects(
    `${apiBase}/app/installations/${req.installationId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    },
    "GitHub installation lookup endpoint",
    fetchFn
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub installation lookup failed: ${response.status} ${response.statusText} — ${body}`);
  }

  const data = (await response.json()) as {
    id?: number;
    app_id?: number;
    account?: { login?: string };
  };
  return {
    installationId: Number(data.id ?? req.installationId),
    accountLogin: String(data.account?.login ?? "unknown"),
    appId: Number(data.app_id ?? req.appId)
  };
}

/**
 * Returns the public slug for this GitHub App (for install URLs). Uses GET /app with app JWT.
 * Returns null if the request fails or the response has no slug.
 */
export async function fetchGithubAppSlug(
  req: { appId: number; privateKey: string },
  opts?: { fetch?: typeof globalThis.fetch; apiBase?: string }
): Promise<string | null> {
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const apiBase = opts?.apiBase ?? "https://api.github.com";
  assertSafeOutboundUrl(apiBase, "GitHub API base URL");
  const jwt = createAppJwt(req.appId, req.privateKey);
  try {
    const response = await fetchWithProtectedRedirects(
      `${apiBase}/app`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      },
      "GitHub app metadata endpoint",
      fetchFn
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { slug?: string };
    const slug = data.slug?.trim();
    return slug || null;
  } catch {
    return null;
  }
}
