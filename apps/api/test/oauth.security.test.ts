import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetOAuthStoreForTests,
  addOAuthProvider,
  discoverOIDC,
  exchangeCodeForToken,
  type OAuthProviderConfig
} from "../src/oauth.js";

const publicProvider: OAuthProviderConfig = {
  id: "okta",
  provider: "oidc",
  clientId: "cid",
  clientSecret: "sec",
  authorizeUrl: "https://idp.example.com/authorize",
  tokenUrl: "https://idp.example.com/token",
  userInfoUrl: "https://idp.example.com/userinfo",
  scopes: ["openid", "email"]
};

describe("oauth SSRF protections", () => {
  beforeEach(() => {
    __resetOAuthStoreForTests();
  });

  it("rejects provider registration with private endpoints", () => {
    expect(() =>
      addOAuthProvider({
        ...publicProvider,
        tokenUrl: "http://127.0.0.1/token"
      })
    ).toThrow(/private or blocked host/i);
  });

  it("blocks redirect from public token endpoint to private address", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" }
        })
      );

    await expect(
      exchangeCodeForToken(publicProvider, "code-1", "https://app.example.com/callback", fetchMock)
    ).rejects.toThrow(/private or blocked host/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks OIDC discovery against private hostnames before network request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(discoverOIDC("http://localhost:8080", fetchMock)).rejects.toThrow(/private or blocked host/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buildOAuthProviderFromOIDC maps properties correctly", async () => {
    const { buildOAuthProviderFromOIDC } = await import("../src/oauth.js");
    const provider = buildOAuthProviderFromOIDC(
      { id: "p1", clientId: "cid", clientSecret: "sec", issuerUrl: "url", scopes: ["s1"] },
      { authorization_endpoint: "https://auth", token_endpoint: "https://tok", userinfo_endpoint: "https://ui" }
    );
    expect(provider).toEqual({
      id: "p1",
      provider: "oidc",
      clientId: "cid",
      clientSecret: "sec",
      authorizeUrl: "https://auth",
      tokenUrl: "https://tok",
      userInfoUrl: "https://ui",
      scopes: ["s1"],
    });
  });

  describe("seedGoogleProviderFromEnv", () => {
    it("does nothing if GOOGLE_CLIENT_ID is missing", async () => {
      const { seedGoogleProviderFromEnv, listProviders } = await import("../src/oauth.js");
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      seedGoogleProviderFromEnv();
      expect(listProviders()).toEqual([]);
    });

    it("adds google provider if GOOGLE_CLIENT_ID is set", async () => {
      const { seedGoogleProviderFromEnv, getOAuthProvider } = await import("../src/oauth.js");
      vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
      seedGoogleProviderFromEnv();
      const p = getOAuthProvider("google");
      expect(p).toMatchObject({
        id: "google",
        clientId: "google-client-id",
        clientSecret: "google-client-secret"
      });
    });
  });
});
