import { beforeAll, describe, expect, it } from "vitest";

const webBase = process.env.WEB_BASE ?? "http://localhost:4173";

/** Poll until the static web server returns HTML from GET /. */
async function waitForWebHtml(base: string, maxMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`);
      if (!response.ok) {
        lastErr = new Error(`HTTP ${response.status}`);
      } else {
        const ct = response.headers.get("content-type") ?? "";
        const body = await response.text();
        if (/text\/html/i.test(ct) && (/<!DOCTYPE/i.test(body) || /<\s*html/i.test(body))) {
          return;
        }
        lastErr = new Error("Response was not HTML-like");
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for HTML from ${base}/ (last error: ${String(lastErr)})`);
}

describe("AT web suite", () => {
  beforeAll(async () => {
    await waitForWebHtml(webBase);
  }, 130_000);

  it("AT-WEB-001 GET / returns 200 and HTML-like response", async () => {
    const response = await fetch(`${webBase}/`);
    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toMatch(/text\/html/i);
    const body = await response.text();
    expect(body).toMatch(/<\s*html|!DOCTYPE/i);
  });
});
