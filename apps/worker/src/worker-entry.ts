import { createHealthServer } from "./health-server.js";
import { shutdownWorkersAndRedis, startQueueConsumersFromEnv } from "./worker-runtime.js";

function resolveListenPort(): number {
  const raw = process.env.WORKER_HEALTH_PORT ?? process.env.PORT;
  if (raw === undefined || raw === "") {
    return 9090;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 9090;
}

const host = process.env.WORKER_HEALTH_HOST ?? "0.0.0.0";
const port = resolveListenPort();
const server = createHealthServer();

const { connection, workers } = startQueueConsumersFromEnv(process.env);

if (process.env.REDIS_DISABLED === "1") {
  console.error("[worker] REDIS_DISABLED=1 — BullMQ workers not started");
} else {
  console.error(`[worker] BullMQ: ${workers.length} queue worker(s)`);
}

server.listen(port, host, () => {
  console.error(`[worker] health listening on http://${host}:${port}/health`);
});

server.on("error", (err) => {
  console.error("[worker] health server error", err);
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error(`[worker] ${signal} — shutting down`);
  try {
    await shutdownWorkersAndRedis(workers, connection);
  } catch (e) {
    console.error("[worker] shutdown error", e);
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
