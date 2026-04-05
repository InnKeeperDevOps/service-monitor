/**
 * SSRF protection utilities.
 *
 * `isPrivateUrl` blocks requests targeting RFC 1918 addresses, loopback,
 * and cloud metadata endpoints. When the httpRequest node is implemented,
 * redirect validation MUST re-check `isPrivateUrl` on every redirect target
 * to prevent DNS-rebinding / redirect-based SSRF.
 */

const PRIVATE_RANGES: Array<{ base: number; mask: number }> = [
  { base: (10 << 24) >>> 0, mask: (0xff << 24) >>> 0 },              // 10.0.0.0/8
  { base: ((172 << 24) | (16 << 16)) >>> 0, mask: (0xfff0 << 16) >>> 0 }, // 172.16.0.0/12
  { base: ((192 << 24) | (168 << 16)) >>> 0, mask: (0xffff << 16) >>> 0 } // 192.168.0.0/16
];

const LOCALHOST_V4 = ((127 << 24) | 1) >>> 0; // 127.0.0.1
const METADATA_IP = ((169 << 24) | (254 << 16) | (169 << 8) | 254) >>> 0; // 169.254.169.254

function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n;
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isPrivateUrl(url: string): boolean {
  const host = extractHost(url);
  if (!host) return true; // malformed URLs are blocked

  const ip = ipToNumber(host);
  if (ip === null) {
    const lower = host.toLowerCase();
    return lower === "localhost" || lower.endsWith(".localhost");
  }

  if (ip === LOCALHOST_V4) return true;
  if (ip === METADATA_IP) return true;
  if ((ip >>> 24) === 127) return true; // full 127.0.0.0/8 loopback range

  for (const range of PRIVATE_RANGES) {
    if (((ip & range.mask) >>> 0) === range.base) return true;
  }

  return false;
}
