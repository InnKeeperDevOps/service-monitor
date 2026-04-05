import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

export type ExecutorRunMetadata = {
  startedAt: string;
  endedAt: string;
  /** argv-style command as executed (binary first) */
  command: string[];
  simulated: boolean;
  isolation: "host" | "container";
  runnerImage?: string;
  permissionsProfile?: "restricted" | "repo" | "full";
};

export interface PlanExecutor {
  id: "cursor" | "claude";
  run(input: { workspacePath: string; prompt: string; env: Record<string, string>; permissionsProfile?: "restricted" | "repo" | "full" }): Promise<{
    exitCode: number;
    logUri: string;
    log: string;
    metadata: ExecutorRunMetadata;
  }>;
}

const SM_CURSOR_BIN = "SM_CURSOR_BIN";
const SM_CLAUDE_BIN = "SM_CLAUDE_BIN";
const SM_DOCKER_BIN = "SM_EXECUTOR_DOCKER_BIN";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function getTimeoutMs(): number {
  const v = process.env.SM_EXECUTOR_TIMEOUT_MS;
  if (v !== undefined && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

function envBin(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

/** True if `bin` resolves to an executable on PATH or is an executable path. */
export function isExecutableCommand(bin: string): boolean {
  const result = spawnSync("/bin/sh", ["-c", 'command -v -- "$1"', "isExecutableCommand", bin], {
    encoding: "utf8",
    stdio: "ignore"
  });
  return result.status === 0;
}

function mergeProcessEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

function simulatedLog(id: "cursor" | "claude", workspacePath: string, prompt: string): string {
  return `[${id}] simulated run in ${workspacePath}: ${prompt.slice(0, 64)}`;
}

/**
 * Ensures the workspace directory exists and returns the resolved absolute path.
 * When `SM_WORKSPACE_BASE` is set, all paths are resolved relative to it.
 */
export async function prepareWorkspace(workspacePath: string): Promise<string> {
  const base = process.env.SM_WORKSPACE_BASE;
  const full = base ? resolve(base, workspacePath) : resolve(workspacePath);
  await mkdir(full, { recursive: true });
  return full;
}

function buildArgs(id: "cursor" | "claude", prompt: string, workspacePath: string): string[] {
  if (id === "cursor") {
    return ["--prompt", prompt, "--workspace", workspacePath];
  }
  return ["--prompt", prompt, "--cwd", workspacePath];
}

function timestampToken(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

async function writeExecutionLog(workspacePath: string, fileName: string, content: string): Promise<string> {
  const logsDir = join(workspacePath, ".sm", "logs");
  await mkdir(logsDir, { recursive: true });
  const fullPath = join(logsDir, fileName);
  await writeFile(fullPath, content, "utf8");
  return `file://${fullPath}`;
}

function shouldUseContainerIsolation(id: "cursor" | "claude"): boolean {
  const global = process.env.SM_EXECUTOR_ISOLATE_CONTAINERS === "1";
  const perExecutor = process.env[`SM_EXECUTOR_ISOLATE_CONTAINERS_${id.toUpperCase()}`] === "1";
  return global || perExecutor;
}

function resolveRunnerImage(id: "cursor" | "claude"): string | null {
  const specific = process.env[`SM_EXECUTOR_RUNNER_IMAGE_${id.toUpperCase()}`];
  if (specific && specific.trim() !== "") return specific;
  const global = process.env.SM_EXECUTOR_RUNNER_IMAGE;
  if (global && global.trim() !== "") return global;
  return null;
}

function spawnAsync(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ exitCode: number; log: string; timedOut: boolean }> {
  return new Promise((res) => {
    let settled = false;
    const finish = (v: { exitCode: number; log: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res(v);
    };

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the entire process group so child-of-child processes (e.g. sleep)
      // also die and release their pipe fds, allowing 'close' to fire.
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already dead */ }
    }, opts.timeoutMs);

    child.on("close", (code, signal) => {
      finish({
        exitCode: code ?? (signal ? 1 : 0),
        log: Buffer.concat(chunks).toString("utf8"),
        timedOut
      });
    });

    child.on("error", (err) => {
      finish({ exitCode: 1, log: err.message, timedOut: false });
    });
  });
}

class CliPlanExecutor implements PlanExecutor {
  constructor(
    public readonly id: "cursor" | "claude",
    private readonly binEnvKey: string,
    private readonly defaultBin: string
  ) {}

  async run(input: { workspacePath: string; prompt: string; env: Record<string, string>; permissionsProfile?: "restricted" | "repo" | "full" }): Promise<{
    exitCode: number;
    logUri: string;
    log: string;
    metadata: ExecutorRunMetadata;
  }> {
    const workspacePath = await prepareWorkspace(input.workspacePath);
    const bin = envBin(this.binEnvKey, this.defaultBin);
    const simulateRequested = process.env.SM_EXECUTOR_SIMULATE === "1";
    const simulateAllowed = process.env.SM_EXECUTOR_ALLOW_SIMULATION === "1";
    const simulate =
      simulateAllowed &&
      simulateRequested &&
      (process.env.NODE_ENV !== "production" || process.env.SM_EXECUTOR_SIMULATE_IN_PRODUCTION === "1");
    const startedAt = new Date().toISOString();
    const token = timestampToken(startedAt);
    const profile = input.permissionsProfile ?? "restricted";

    if (simulate) {
      const endedAt = new Date().toISOString();
      const log = simulatedLog(this.id, workspacePath, input.prompt);
      const logUri = await writeExecutionLog(workspacePath, `${this.id}-simulated-${token}.log`, log);
      return {
        exitCode: 0,
        logUri,
        log,
        metadata: {
          startedAt,
          endedAt,
          command: [bin],
          simulated: true,
          isolation: "host",
          permissionsProfile: profile
        }
      };
    }

    const args = buildArgs(this.id, input.prompt, workspacePath);
    const useContainerIsolation = shouldUseContainerIsolation(this.id);
    const runnerImage = useContainerIsolation ? resolveRunnerImage(this.id) : null;
    let command: string[] = [];

    if (useContainerIsolation && !runnerImage) {
      const endedAt = new Date().toISOString();
      const log = `[${this.id}] container isolation requested but runner image is not configured. Set SM_EXECUTOR_RUNNER_IMAGE or SM_EXECUTOR_RUNNER_IMAGE_${this.id.toUpperCase()}.`;
      const logUri = await writeExecutionLog(workspacePath, `${this.id}-failed-${token}.log`, log);
      return {
        exitCode: 78,
        logUri,
        log,
        metadata: {
          startedAt,
          endedAt,
          command: [envBin(SM_DOCKER_BIN, "docker")],
          simulated: false,
          isolation: "container",
          runnerImage: undefined,
          permissionsProfile: profile
        }
      };
    }

    let result: { exitCode: number; log: string; timedOut: boolean };
    if (useContainerIsolation) {
      const dockerBin = envBin(SM_DOCKER_BIN, "docker");
      if (!isExecutableCommand(dockerBin)) {
        const endedAt = new Date().toISOString();
        const log = `[${this.id}] executable not found: ${dockerBin}. Set ${SM_DOCKER_BIN}.`;
        const logUri = await writeExecutionLog(workspacePath, `${this.id}-failed-${token}.log`, log);
        return {
          exitCode: 127,
          logUri,
          log,
          metadata: {
            startedAt,
            endedAt,
            command: [dockerBin],
            simulated: false,
            isolation: "container",
            runnerImage: runnerImage ?? undefined,
            permissionsProfile: profile
          }
        };
      }
      const envArgs = Object.entries(input.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      command = [
        dockerBin,
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${workspacePath}:/workspace`,
        "-w",
        "/workspace",
        ...envArgs,
        runnerImage!,
        bin,
        ...args
      ];
      result = await spawnAsync(command[0], command.slice(1), {
        cwd: workspacePath,
        env: mergeProcessEnv({}),
        timeoutMs: getTimeoutMs()
      });
    } else {
      if (!isExecutableCommand(bin)) {
        const endedAt = new Date().toISOString();
        const log = `[${this.id}] executable not found: ${bin}. Set ${this.binEnvKey}.`;
        const logUri = await writeExecutionLog(workspacePath, `${this.id}-failed-${token}.log`, log);
        return {
          exitCode: 127,
          logUri,
          log,
          metadata: {
            startedAt,
            endedAt,
            command: [bin],
            simulated: false,
            isolation: "host",
            permissionsProfile: profile
          }
        };
      }
      command = [bin, ...args];
      result = await spawnAsync(bin, args, {
        cwd: workspacePath,
        env: mergeProcessEnv(input.env),
        timeoutMs: getTimeoutMs()
      });
    }

    const endedAt = new Date().toISOString();
    const logUri = await writeExecutionLog(workspacePath, `${this.id}-${token}.log`, result.log);

    return {
      exitCode: result.exitCode,
      logUri,
      log: result.log,
      metadata: {
        startedAt,
        endedAt,
        command,
        simulated: false,
        isolation: useContainerIsolation ? "container" : "host",
        runnerImage: runnerImage ?? undefined,
        permissionsProfile: profile
      }
    };
  }
}

/** Returns a real or simulated executor based on environment configuration. */
export function createExecutor(id: "cursor" | "claude"): PlanExecutor {
  if (id === "cursor") return new CliPlanExecutor("cursor", SM_CURSOR_BIN, "cursor");
  return new CliPlanExecutor("claude", SM_CLAUDE_BIN, "claude");
}

export const executors: Record<"cursor" | "claude", PlanExecutor> = {
  cursor: createExecutor("cursor"),
  claude: createExecutor("claude")
};
