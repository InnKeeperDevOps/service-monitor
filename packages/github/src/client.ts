import { createInstallationToken, type InstallationTokenRequest } from "./installation-token.js";
import { assertSafeOutboundUrl, fetchWithProtectedRedirects } from "./ssrf-fetch.js";

export type GitHubAppClientOptions = {
  appId: number;
  privateKey: string;
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
};

type CachedToken = { token: string; expiresAt: number };

/**
 * High-level GitHub App client that caches installation tokens and
 * wraps common mutation operations (PR, merge, push, workflow dispatch).
 */
export class GitHubAppClient {
  private tokenCache = new Map<number, CachedToken>();
  private readonly appId: number;
  private readonly privateKey: string;
  private readonly apiBase: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: GitHubAppClientOptions) {
    this.appId = opts.appId;
    this.privateKey = opts.privateKey;
    this.apiBase = opts.apiBase ?? "https://api.github.com";
    assertSafeOutboundUrl(this.apiBase, "GitHub API base URL");
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    const now = Date.now();
    if (cached && cached.expiresAt > now + 60_000) {
      return cached.token;
    }

    const req: InstallationTokenRequest = {
      appId: this.appId,
      privateKey: this.privateKey,
      installationId
    };
    const result = await createInstallationToken(req, {
      fetch: this.fetchFn,
      apiBase: this.apiBase
    });

    this.tokenCache.set(installationId, {
      token: result.token,
      expiresAt: Date.parse(result.expiresAt)
    });

    return result.token;
  }

  private async authedFetch(installationId: number, url: string, init?: RequestInit): Promise<Response> {
    const token = await this.getInstallationToken(installationId);
    return fetchWithProtectedRedirects(
      url,
      {
        ...init,
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init?.headers as Record<string, string> | undefined)
        }
      },
      "GitHub API request",
      this.fetchFn
    );
  }

  async createPullRequest(
    installationId: number,
    repo: string,
    opts: { title: string; head: string; base: string; body?: string }
  ): Promise<{ number: number; html_url: string }> {
    const res = await this.authedFetch(
      installationId,
      `${this.apiBase}/repos/${repo}/pulls`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts)
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub createPR failed: ${res.status} — ${text}`);
    }
    const data = (await res.json()) as { number: number; html_url: string };
    return { number: data.number, html_url: data.html_url };
  }

  async mergePullRequest(
    installationId: number,
    repo: string,
    pullNumber: number,
    opts?: { merge_method?: "merge" | "squash" | "rebase" }
  ): Promise<{ merged: boolean }> {
    const res = await this.authedFetch(
      installationId,
      `${this.apiBase}/repos/${repo}/pulls/${pullNumber}/merge`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts ?? {})
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub mergePR failed: ${res.status} — ${text}`);
    }
    const data = (await res.json()) as { merged: boolean };
    return { merged: data.merged };
  }

  async dispatchWorkflow(
    installationId: number,
    repo: string,
    workflowId: string | number,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    const res = await this.authedFetch(
      installationId,
      `${this.apiBase}/repos/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, inputs: inputs ?? {} })
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub dispatchWorkflow failed: ${res.status} — ${text}`);
    }
  }

  async cloneRepo(
    installationId: number,
    repo: string,
    branch: string,
    targetDir: string
  ): Promise<{ cloneUrl: string; command: string }> {
    const token = await this.getInstallationToken(installationId);
    const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
    const command = `git clone --single-branch --branch ${branch} ${cloneUrl} ${targetDir}`;
    return { cloneUrl, command };
  }

  async push(
    installationId: number,
    repo: string,
    branch: string,
    _options?: Record<string, unknown>
  ): Promise<{ pushUrl: string }> {
    const token = await this.getInstallationToken(installationId);
    const pushUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
    return { pushUrl };
  }

  async commentOnPR(
    installationId: number,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<{ id: number; html_url: string }> {
    const res = await this.authedFetch(
      installationId,
      `${this.apiBase}/repos/${repo}/issues/${pullNumber}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body })
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub commentOnPR failed: ${res.status} — ${text}`);
    }
    const data = (await res.json()) as { id: number; html_url: string };
    return { id: data.id, html_url: data.html_url };
  }

  async createIssue(
    installationId: number,
    repo: string,
    opts: { title: string; body?: string; labels?: string[] }
  ): Promise<{ number: number; html_url: string }> {
    const res = await this.authedFetch(
      installationId,
      `${this.apiBase}/repos/${repo}/issues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts)
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub createIssue failed: ${res.status} — ${text}`);
    }
    const data = (await res.json()) as { number: number; html_url: string };
    return { number: data.number, html_url: data.html_url };
  }

  async addLabels(
    installationId: number,
    repo: string,
    issueNumber: number,
    labels: string[]
  ): Promise<{ labels: string[] }> {
    const res = await this.authedFetch(
      installationId,
      `${this.apiBase}/repos/${repo}/issues/${issueNumber}/labels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels })
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub addLabels failed: ${res.status} — ${text}`);
    }
    const data = (await res.json()) as { name: string }[];
    return { labels: data.map((l) => l.name) };
  }
}
