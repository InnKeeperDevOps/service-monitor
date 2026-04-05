import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { GitHubAppClient } from "../src/client.js";
import { createAppJwt, createInstallationToken, getInstallationMetadata } from "../src/installation-token.js";
import { policyGuardedMutation } from "../src/policy-guard.js";

const TEST_KEY = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
}).privateKey;

describe("policyGuardedMutation", () => {
  const policy = { repos: ["acme/app"], branches: ["main"], actions: ["create_pr" as const, "push" as const] };

  it("allows when repo, branch, and action are all allowlisted", () => {
    const result = policyGuardedMutation(policy, "acme/app", "main", "create_pr");
    expect(result).toEqual({ allowed: true });
  });

  it("denies when repo is not allowlisted", () => {
    const result = policyGuardedMutation(policy, "other/repo", "main", "create_pr");
    expect(result).toEqual({ allowed: false, reason: "REPO_NOT_ALLOWLISTED" });
  });

  it("denies when branch is not allowlisted", () => {
    const result = policyGuardedMutation(policy, "acme/app", "develop", "create_pr");
    expect(result).toEqual({ allowed: false, reason: "BRANCH_NOT_ALLOWLISTED" });
  });

  it("denies when action is not allowlisted", () => {
    const result = policyGuardedMutation(policy, "acme/app", "main", "merge_pr");
    expect(result).toEqual({ allowed: false, reason: "ACTION_NOT_ALLOWLISTED" });
  });

  it("denies when policy is undefined", () => {
    const result = policyGuardedMutation(undefined, "acme/app", "main", "push");
    expect(result).toEqual({ allowed: false, reason: "POLICY_NOT_CONFIGURED" });
  });
});

describe("createInstallationToken", () => {
  it("exchanges JWT for installation token via mocked fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_test123", expires_at: "2026-04-05T00:00:00Z" })
    });

    const result = await createInstallationToken(
      { appId: 12345, privateKey: fakeRsaKey(), installationId: 42 },
      { fetch: mockFetch as unknown as typeof fetch, apiBase: "https://api.github.com" }
    );

    expect(result.token).toBe("ghs_test123");
    expect(result.expiresAt).toBe("2026-04-05T00:00:00Z");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain("/app/installations/42/access_tokens");
    expect(init.method).toBe("POST");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad creds"
    });

    await expect(
      createInstallationToken(
        { appId: 1, privateKey: fakeRsaKey(), installationId: 1 },
        { fetch: mockFetch as unknown as typeof fetch }
      )
    ).rejects.toThrow("GitHub installation token exchange failed");
  });

  it("blocks private apiBase URLs", async () => {
    const mockFetch = vi.fn();
    await expect(
      createInstallationToken(
        { appId: 1, privateKey: fakeRsaKey(), installationId: 1 },
        { fetch: mockFetch as unknown as typeof fetch, apiBase: "http://127.0.0.1:8080" }
      )
    ).rejects.toThrow(/private/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks redirect chains that target private hosts", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? "http://169.254.169.254/token" : null) }
      });

    await expect(
      createInstallationToken(
        { appId: 1, privateKey: fakeRsaKey(), installationId: 1 },
        { fetch: mockFetch as unknown as typeof fetch, apiBase: "https://api.github.com" }
      )
    ).rejects.toThrow(/private/i);
  });
});

describe("getInstallationMetadata", () => {
  it("loads installation account login and app id", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 77, account: { login: "acme-corp" }, app_id: 12345 })
    });

    const metadata = await getInstallationMetadata(
      { appId: 12345, privateKey: fakeRsaKey(), installationId: 77 },
      { fetch: mockFetch as unknown as typeof fetch, apiBase: "https://api.github.com" }
    );

    expect(metadata).toEqual({
      installationId: 77,
      accountLogin: "acme-corp",
      appId: 12345
    });
  });

  it("fails on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "missing"
    });

    await expect(
      getInstallationMetadata(
        { appId: 1, privateKey: fakeRsaKey(), installationId: 77 },
        { fetch: mockFetch as unknown as typeof fetch, apiBase: "https://api.github.com" }
      )
    ).rejects.toThrow("GitHub installation lookup failed");
  });
});

describe("createAppJwt", () => {
  it("produces a three-part JWT string", () => {
    const jwt = createAppJwt(12345, fakeRsaKey());
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    expect(header.alg).toBe("RS256");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    expect(payload.iss).toBe("12345");
  });
});

describe("GitHubAppClient", () => {
  it("rejects private apiBase configuration", () => {
    expect(
      () =>
        new GitHubAppClient({
          appId: 1,
          privateKey: fakeRsaKey(),
          apiBase: "http://10.0.0.4:3000",
          fetch: vi.fn() as unknown as typeof fetch
        })
    ).toThrow(/private/i);
  });

  it("caches installation tokens across calls", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_cached",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 1, html_url: "https://github.com/acme/app/pull/1" })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 2, html_url: "https://github.com/acme/app/pull/2" })
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    await client.createPullRequest(42, "acme/app", { title: "PR 1", head: "feat", base: "main" });
    await client.createPullRequest(42, "acme/app", { title: "PR 2", head: "fix", base: "main" });

    // Only 1 token request + 2 PR requests = 3 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("blocks API redirect chains that target private hosts", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_cached",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? "http://127.0.0.1/internal" : null) }
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    await expect(
      client.createPullRequest(42, "acme/app", { title: "PR", head: "feat", base: "main" })
    ).rejects.toThrow(/private/i);
  });

  it("cloneRepo returns authenticated clone URL and command", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: "ghs_clone",
        expires_at: new Date(Date.now() + 3600_000).toISOString()
      })
    });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    const result = await client.cloneRepo(42, "acme/app", "main", "/tmp/acme-app");
    expect(result.cloneUrl).toBe("https://x-access-token:ghs_clone@github.com/acme/app.git");
    expect(result.command).toBe(
      "git clone --single-branch --branch main https://x-access-token:ghs_clone@github.com/acme/app.git /tmp/acme-app"
    );
  });

  it("push returns authenticated push URL", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: "ghs_push",
        expires_at: new Date(Date.now() + 3600_000).toISOString()
      })
    });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    const result = await client.push(42, "acme/app", "feat-branch");
    expect(result.pushUrl).toBe("https://x-access-token:ghs_push@github.com/acme/app.git");
  });

  it("commentOnPR posts a comment and returns id + url", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_comment",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 999,
          html_url: "https://github.com/acme/app/pull/5#issuecomment-999"
        })
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    const result = await client.commentOnPR(42, "acme/app", 5, "LGTM!");
    expect(result).toEqual({ id: 999, html_url: "https://github.com/acme/app/pull/5#issuecomment-999" });

    const [url, init] = mockFetch.mock.calls[1]!;
    expect(url).toContain("/repos/acme/app/issues/5/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ body: "LGTM!" });
  });

  it("commentOnPR throws on non-ok response", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_err",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found"
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    await expect(client.commentOnPR(42, "acme/app", 999, "oops")).rejects.toThrow(
      "GitHub commentOnPR failed: 404"
    );
  });

  it("createIssue posts an issue and returns number + url", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_issue",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          html_url: "https://github.com/acme/app/issues/42"
        })
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    const result = await client.createIssue(42, "acme/app", {
      title: "Bug report",
      body: "Something broke",
      labels: ["bug"]
    });
    expect(result).toEqual({ number: 42, html_url: "https://github.com/acme/app/issues/42" });

    const [url, init] = mockFetch.mock.calls[1]!;
    expect(url).toContain("/repos/acme/app/issues");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      title: "Bug report",
      body: "Something broke",
      labels: ["bug"]
    });
  });

  it("createIssue throws on non-ok response", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_err",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => "Validation Failed"
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    await expect(
      client.createIssue(42, "acme/app", { title: "" })
    ).rejects.toThrow("GitHub createIssue failed: 422");
  });

  it("addLabels posts labels and returns label names", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_labels",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: "bug" },
          { name: "urgent" }
        ]
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    const result = await client.addLabels(42, "acme/app", 10, ["bug", "urgent"]);
    expect(result).toEqual({ labels: ["bug", "urgent"] });

    const [url, init] = mockFetch.mock.calls[1]!;
    expect(url).toContain("/repos/acme/app/issues/10/labels");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ labels: ["bug", "urgent"] });
  });

  it("addLabels throws on non-ok response", async () => {
    const mockFetch = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_err",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found"
      });

    const client = new GitHubAppClient({
      appId: 1,
      privateKey: fakeRsaKey(),
      fetch: mockFetch as unknown as typeof fetch
    });

    await expect(client.addLabels(42, "acme/app", 999, ["bug"])).rejects.toThrow(
      "GitHub addLabels failed: 404"
    );
  });
});

function fakeRsaKey(): string {
  return TEST_KEY;
}
