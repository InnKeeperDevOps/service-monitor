import net from "node:net";

export type ReadinessOk = { ok: true };
export type ReadinessFail = { ok: false; code: string; message: string };
export type ReadinessResult = ReadinessOk | ReadinessFail;

/** Returns true when both host and port env vars are present (dependency is configured). */
export function isDependencyConfigured(hostEnv: string | undefined, portEnv: string | undefined): boolean {
  return Boolean(hostEnv && portEnv && hostEnv.trim() !== "" && portEnv.trim() !== "");
}

export function parsePort(portEnv: string): number | null {
  const port = Number.parseInt(portEnv, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

/**
 * Opens a TCP connection to host:port and closes it immediately on success.
 * Used for readiness without pulling in pg/redis drivers.
 */
export function checkTcpReachable(host: string, port: number, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
    };

    socket.once("connect", () => {
      cleanup();
      socket.end();
      resolve();
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err);
    });
  });
}

export type ReadinessChecker = () => Promise<ReadinessResult>;

function postgresChecker(host: string, port: number): ReadinessChecker {
  return async () => {
    try {
      await checkTcpReachable(host, port);
      return { ok: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: "POSTGRES_UNAVAILABLE",
        message: `Postgres dependency check failed (${host}:${port}): ${detail}`
      };
    }
  };
}

function redisChecker(host: string, port: number): ReadinessChecker {
  return async () => {
    try {
      await checkTcpReachable(host, port);
      return { ok: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: "REDIS_UNAVAILABLE",
        message: `Redis dependency check failed (${host}:${port}): ${detail}`
      };
    }
  };
}

/**
 * Builds default readiness checkers from POSTGRES_* / REDIS_* env vars.
 * Omitted vars mean that dependency is not checked (dev fallback).
 */
export function createReadinessCheckersFromEnv(env: NodeJS.ProcessEnv = process.env): ReadinessChecker[] {
  const checkers: ReadinessChecker[] = [];

  const pgHost = env.POSTGRES_HOST;
  const pgPortRaw = env.POSTGRES_PORT;
  if (isDependencyConfigured(pgHost, pgPortRaw)) {
    const port = parsePort(pgPortRaw!);
    if (port === null) {
      checkers.push(async () => ({
        ok: false,
        code: "POSTGRES_CONFIG_INVALID",
        message: "POSTGRES_PORT must be a valid TCP port (1–65535)"
      }));
    } else {
      checkers.push(postgresChecker(pgHost!, port));
    }
  }

  const redisHost = env.REDIS_HOST;
  const redisPortRaw = env.REDIS_PORT;
  if (isDependencyConfigured(redisHost, redisPortRaw)) {
    const port = parsePort(redisPortRaw!);
    if (port === null) {
      checkers.push(async () => ({
        ok: false,
        code: "REDIS_CONFIG_INVALID",
        message: "REDIS_PORT must be a valid TCP port (1–65535)"
      }));
    } else {
      checkers.push(redisChecker(redisHost!, port));
    }
  }

  return checkers;
}
