import { describe, expect, it } from "vitest";
import { createHealthServer } from "../src/health-server.js";
async function listenRandom(server) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
        throw new Error("expected TCP listen address");
    }
    return {
        port: addr.port,
        close: () => new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        })
    };
}
describe("worker health server", () => {
    it("GET /health returns 200", async () => {
        const server = createHealthServer();
        const { port, close } = await listenRandom(server);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            expect(response.status).toBe(200);
        }
        finally {
            await close();
        }
    });
    it("GET /unknown returns 404", async () => {
        const server = createHealthServer();
        const { port, close } = await listenRandom(server);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/unknown`);
            expect(response.status).toBe(404);
        }
        finally {
            await close();
        }
    });
});
//# sourceMappingURL=health-server.test.js.map