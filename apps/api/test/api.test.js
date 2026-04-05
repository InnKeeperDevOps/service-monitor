import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { apiErrorSchema } from "@sm/contracts";
import { buildServer } from "../src/server.js";
const app = buildServer();
beforeAll(async () => {
    await app.ready();
});
afterAll(async () => {
    await app.close();
});
describe("api", () => {
    it("returns health", async () => {
        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.statusCode).toBe(200);
    });
    it("requires auth for /api/v1/me", async () => {
        const response = await app.inject({ method: "GET", url: "/api/v1/me" });
        expect(response.statusCode).toBe(401);
    });
    it("supports authenticated /api/v1/me", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/me",
            headers: { authorization: "Bearer dev-token" }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().tenantId).toBe("t-1");
    });
    it("blocks cross-tenant settings writes", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/settings",
            headers: { authorization: "Bearer dev-token" },
            payload: { tenantId: "t-2", githubRepo: "o/r", defaultBranch: "main" }
        });
        expect(response.statusCode).toBe(403);
    });
    it("rejects invalid webhook signature", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/webhooks/github",
            payload: { hello: "world" }
        });
        expect(response.statusCode).toBe(401);
    });
    it("accepts valid webhook signature", async () => {
        const payload = JSON.stringify({ hello: "world" });
        const sig = crypto.createHmac("sha256", "test-secret").update(payload).digest("hex");
        const response = await app.inject({
            method: "POST",
            url: "/webhooks/github",
            payload,
            headers: {
                "content-type": "application/json",
                "x-hub-signature-256": `sha256=${sig}`
            }
        });
        expect(response.statusCode).toBe(200);
    });
    describe("POST /api/v1/github/policy/check", () => {
        it("returns 401 when unauthenticated", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/v1/github/policy/check",
                payload: { repo: "o/r", branch: "main", action: "create_pr" }
            });
            expect(response.statusCode).toBe(401);
        });
        it("returns allowed=true for allowlisted repo/branch/action", async () => {
            await app.inject({
                method: "POST",
                url: "/api/v1/settings",
                headers: { authorization: "Bearer dev-token" },
                payload: {
                    tenantId: "t-1",
                    githubRepo: "o/r",
                    defaultBranch: "main",
                    automationPolicy: {
                        repos: ["acme/repo"],
                        branches: ["main"],
                        actions: ["create_pr"]
                    }
                }
            });
            const response = await app.inject({
                method: "POST",
                url: "/api/v1/github/policy/check",
                headers: { authorization: "Bearer dev-token" },
                payload: { repo: "acme/repo", branch: "main", action: "create_pr" }
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ allowed: true });
        });
        it("returns 403 with reason POLICY_DENY when blocked", async () => {
            await app.inject({
                method: "POST",
                url: "/api/v1/settings",
                headers: { authorization: "Bearer dev-token" },
                payload: {
                    tenantId: "t-1",
                    githubRepo: "o/r",
                    defaultBranch: "main",
                    automationPolicy: {
                        repos: ["acme/repo"],
                        branches: ["main"],
                        actions: ["push"]
                    }
                }
            });
            const response = await app.inject({
                method: "POST",
                url: "/api/v1/github/policy/check",
                headers: { authorization: "Bearer dev-token" },
                payload: { repo: "acme/repo", branch: "main", action: "create_pr" }
            });
            expect(response.statusCode).toBe(403);
            const body = response.json();
            expect(body.code).toBe("POLICY_DENY");
        });
    });
    describe("WebSocket /realtime", () => {
        let wsApp;
        let baseUrl;
        beforeAll(async () => {
            wsApp = buildServer();
            await wsApp.ready();
            await wsApp.listen({ port: 0, host: "127.0.0.1" });
            const addr = wsApp.server.address();
            if (addr === null || typeof addr === "string") {
                throw new Error("expected listening tcp address");
            }
            baseUrl = `ws://127.0.0.1:${addr.port}`;
        });
        afterAll(async () => {
            await wsApp.close();
        });
        it("sends hello then ack for a valid heartbeat", async () => {
            const ws = new WebSocket(`${baseUrl}/realtime`);
            await new Promise((resolve, reject) => {
                ws.once("open", () => resolve());
                ws.once("error", reject);
            });
            const helloRaw = await new Promise((resolve, reject) => {
                ws.once("message", (d) => resolve(d.toString()));
                ws.once("error", reject);
            });
            expect(JSON.parse(helloRaw)).toEqual({ type: "hello", service: "realtime" });
            ws.send(JSON.stringify({
                type: "heartbeat",
                agentId: "a-test",
                ts: new Date().toISOString(),
                capacity: 2
            }));
            const ackRaw = await new Promise((resolve, reject) => {
                ws.once("message", (d) => resolve(d.toString()));
                ws.once("error", reject);
            });
            expect(JSON.parse(ackRaw)).toEqual({ type: "ack", accepted: true });
            ws.close();
            await new Promise((resolve) => ws.once("close", resolve));
        });
        it("sends apiError-like frame and closes on invalid JSON", async () => {
            const ws = new WebSocket(`${baseUrl}/realtime`);
            await new Promise((resolve, reject) => {
                ws.once("open", () => resolve());
                ws.once("error", reject);
            });
            await new Promise((resolve) => ws.once("message", (d) => resolve(d.toString())));
            ws.send("not-json{");
            const errorRaw = await new Promise((resolve, reject) => {
                ws.once("message", (d) => resolve(d.toString()));
                ws.once("error", reject);
            });
            const err = apiErrorSchema.parse(JSON.parse(errorRaw));
            expect(err.code).toBe("INVALID_MESSAGE");
            await new Promise((resolve) => ws.once("close", resolve));
            expect(ws.readyState).toBe(WebSocket.CLOSED);
        });
        it("sends apiError-like frame and closes on JSON that fails schema", async () => {
            const ws = new WebSocket(`${baseUrl}/realtime`);
            await new Promise((resolve, reject) => {
                ws.once("open", () => resolve());
                ws.once("error", reject);
            });
            await new Promise((resolve) => ws.once("message", (d) => resolve(d.toString())));
            ws.send(JSON.stringify({ type: "not_a_real_message", x: 1 }));
            const errorRaw = await new Promise((resolve, reject) => {
                ws.once("message", (d) => resolve(d.toString()));
                ws.once("error", reject);
            });
            const err = apiErrorSchema.parse(JSON.parse(errorRaw));
            expect(err.code).toBe("INVALID_MESSAGE");
            await new Promise((resolve) => ws.once("close", resolve));
        });
    });
});
//# sourceMappingURL=api.test.js.map