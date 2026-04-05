const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOOPBACK_V4 = ((127 << 24) | 1) >>> 0;
const METADATA_V4 = ((169 << 24) | (254 << 16) | (169 << 8) | 254) >>> 0;
const PRIVATE_V4_RANGES: Array<{ base: number; mask: number }> = [
  { base: (10 << 24) >>> 0, mask: (0xff << 24) >>> 0 },
  { base: ((172 << 24) | (16 << 16)) >>> 0, mask: (0xfff0 << 16) >>> 0 },
  { base: ((192 << 24) | (168 << 16)) >>> 0, mask: (0xffff << 16) >>> 0 }
];

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

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
  if (ip === null) return false;
  if (ip === LOOPBACK_V4 || ip === METADATA_V4 || (ip >>> 24) === 127) {
    return true;
  }
  return PRIVATE_V4_RANGES.some((range) => ((ip & range.mask) >>> 0) === range.base);
}

export function assertSafeOutboundUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!isHttpProtocol(parsed.protocol)) {
    throw new Error(`${label} must use http(s)`);
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new Error(`${label} targets a private or blocked host`);
  }
}

function responseLocation(response: Response): string | null {
  const headers = response.headers as { get?(name: string): string | null } | undefined;
  if (!headers?.get) return null;
  return headers.get("location");
}

export async function fetchWithProtectedRedirects(
  url: string,
  init: RequestInit | undefined,
  label: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    assertSafeOutboundUrl(currentUrl, label);
    const response = await fetchFn(currentUrl, { ...init, redirect: "manual" });
    const location = responseLocation(response);
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
