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
      .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
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
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    await expect(discoverOIDC("http://localhost:8080", fetchMock)).rejects.toThrow(/private or blocked host/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
