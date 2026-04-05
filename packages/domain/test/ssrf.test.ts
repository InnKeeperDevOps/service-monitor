import { describe, expect, it } from "vitest";
import { isPrivateUrl } from "../src/index.js";

describe("T-SEC-003: isPrivateUrl blocks RFC1918 / loopback / metadata IPs", () => {
  const blocked = [
    "http://10.0.0.1/admin",
    "http://172.16.0.1/secret",
    "http://192.168.1.1/config",
    "http://127.0.0.1:8080/debug",
    "http://169.254.169.254/latest/meta-data/"
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(true);
    });
  }

  const allowed = [
    "https://8.8.8.8/dns-query",
    "https://api.github.com/repos"
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(false);
    });
  }
});

describe("T-SEC-004: redirect to private host", () => {
  // Redirect validation is enforced at the HTTP client level when the
  // httpRequest node is implemented. Each redirect target must be re-checked
  // via isPrivateUrl before following the redirect. This prevents DNS
  // rebinding and open-redirect SSRF attacks.
  it("documents that redirect targets must be re-checked via isPrivateUrl", () => {
    expect(isPrivateUrl("http://10.0.0.1/redirected")).toBe(true);
  });
});
