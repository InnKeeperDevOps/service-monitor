import { createServer, type Server } from "node:http";

/** HTTP server exposing GET /health for worker liveness. */
export function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
