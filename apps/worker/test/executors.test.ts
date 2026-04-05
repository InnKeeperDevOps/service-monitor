import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executors, createExecutor, prepareWorkspace } from "../src/executors.js";

describe("CLI executors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses simulated output when SM_EXECUTOR_SIMULATE=1", async () => {
    vi.stubEnv("SM_EXECUTOR_SIMULATE", "1");
    vi.stubEnv("SM_EXECUTOR_ALLOW_SIMULATION", "1");
    vi.stubEnv("SM_CURSOR_BIN", "cursor");
    const r = await executors.cursor.run({
      workspacePath: "/tmp/ws",
      prompt: "hello world",
      env: {}
    });
    expect(r.metadata.simulated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain("[cursor] simulated run in /tmp/ws:");
    expect(r.log).toContain("hello world".slice(0, 64));
    expect(r.metadata.command).toEqual(["cursor"]);
    expect(r.metadata.isolation).toBe("host");
    expect(r.metadata.startedAt <= r.metadata.endedAt).toBe(true);
  });

  it("ignores simulate flag unless SM_EXECUTOR_ALLOW_SIMULATION=1", async () => {
    vi.stubEnv("SM_EXECUTOR_SIMULATE", "1");
    vi.stubEnv("SM_CURSOR_BIN", "/nonexistent/path/cursor-sm-test-missing-bin");
    const r = await executors.cursor.run({
      workspacePath: "/tmp/ws-no-sim",
      prompt: "hello world",
      env: {}
    });
    expect(r.metadata.simulated).toBe(false);
    expect(r.exitCode).toBe(127);
  });

  it("disables simulation in production unless explicitly allowed", async () => {
    vi.stubEnv("SM_EXECUTOR_SIMULATE", "1");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SM_CURSOR_BIN", "/nonexistent/path/cursor-sm-test-missing-bin");
    const r = await executors.cursor.run({
      workspacePath: "/tmp/ws-prod",
      prompt: "hello world",
      env: {}
    });
    expect(r.metadata.simulated).toBe(false);
    expect(r.exitCode).toBe(127);
    expect(r.metadata.isolation).toBe("host");
  });

  it("fails with explicit error when binary is unavailable", async () => {
    vi.stubEnv("SM_CLAUDE_BIN", "/nonexistent/path/claude-sm-test-missing-bin");
    const r = await executors.claude.run({
      workspacePath: "/tmp/ws2",
      prompt: "prompt",
      env: {}
    });
    expect(r.metadata.simulated).toBe(false);
    expect(r.exitCode).toBe(127);
    expect(r.log).toContain("executable not found");
    expect(r.metadata.command).toEqual(["/nonexistent/path/claude-sm-test-missing-bin"]);
    expect(r.metadata.isolation).toBe("host");
  });
});

describe("prepareWorkspace", () => {
  let tempBase: string;

  beforeAll(async () => {
    tempBase = await mkdtemp(join(tmpdir(), "sm-exec-ws-"));
  });

  afterAll(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates nested directories and returns absolute path", async () => {
    const ws = join(tempBase, "a", "b", "workspace");
    const result = await prepareWorkspace(ws);
    expect(result).toBe(ws);
    const s = await stat(result);
    expect(s.isDirectory()).toBe(true);
  });

  it("is idempotent for existing directories", async () => {
    const ws = join(tempBase, "existing");
    await prepareWorkspace(ws);
    const result = await prepareWorkspace(ws);
    expect(result).toBe(ws);
  });

  it("prefixes with SM_WORKSPACE_BASE when set", async () => {
    vi.stubEnv("SM_WORKSPACE_BASE", tempBase);
    const result = await prepareWorkspace("relative/project");
    expect(result).toBe(join(tempBase, "relative/project"));
    const s = await stat(result);
    expect(s.isDirectory()).toBe(true);
  });
});

describe("createExecutor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a cursor executor", () => {
    const exec = createExecutor("cursor");
    expect(exec.id).toBe("cursor");
  });

  it("returns a claude executor", () => {
    const exec = createExecutor("claude");
    expect(exec.id).toBe("claude");
  });
});

describe("real execution with /bin/echo", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("spawns cursor CLI and captures stdout", async () => {
    vi.stubEnv("SM_CURSOR_BIN", "/bin/echo");
    const exec = createExecutor("cursor");
    const r = await exec.run({
      workspacePath: "/tmp",
      prompt: "fix the bug",
      env: { MY_VAR: "123" }
    });
    expect(r.metadata.simulated).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain("--prompt");
    expect(r.log).toContain("fix the bug");
    expect(r.log).toContain("--workspace");
    expect(r.metadata.command[0]).toBe("/bin/echo");
    expect(r.metadata.command).toContain("--prompt");
    expect(r.metadata.isolation).toBe("host");
  });

  it("spawns claude CLI with correct args", async () => {
    vi.stubEnv("SM_CLAUDE_BIN", "/bin/echo");
    const exec = createExecutor("claude");
    const r = await exec.run({
      workspacePath: "/tmp",
      prompt: "deploy it",
      env: {}
    });
    expect(r.metadata.simulated).toBe(false);
    expect(r.log).toContain("--cwd");
    expect(r.log).not.toContain("--workspace");
    expect(r.metadata.command).toContain("--cwd");
    expect(r.metadata.isolation).toBe("host");
  });

  it("captures nonzero exit code", async () => {
    vi.stubEnv("SM_CURSOR_BIN", "/bin/false");
    const exec = createExecutor("cursor");
    const r = await exec.run({
      workspacePath: "/tmp",
      prompt: "anything",
      env: {}
    });
    expect(r.metadata.simulated).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.metadata.isolation).toBe("host");
  });

  it("sets permissionsProfile in metadata", async () => {
    vi.stubEnv("SM_CURSOR_BIN", "/bin/echo");
    const exec = createExecutor("cursor");
    const r = await exec.run({
      workspacePath: "/tmp",
      prompt: "test",
      env: {},
      permissionsProfile: "full"
    });
    expect(r.metadata.permissionsProfile).toBe("full");
    expect(r.metadata.isolation).toBe("host");
  });
});

describe("container isolation mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when isolation is enabled without runner image", async () => {
    vi.stubEnv("SM_EXECUTOR_ISOLATE_CONTAINERS", "1");
    const exec = createExecutor("cursor");
    const r = await exec.run({
      workspacePath: "/tmp",
      prompt: "test",
      env: {}
    });
    expect(r.exitCode).toBe(78);
    expect(r.metadata.isolation).toBe("container");
    expect(r.log).toContain("runner image is not configured");
  });

  it("uses docker runner command when isolation is enabled", async () => {
    vi.stubEnv("SM_EXECUTOR_ISOLATE_CONTAINERS", "1");
    vi.stubEnv("SM_EXECUTOR_RUNNER_IMAGE", "acme/executor:latest");
    vi.stubEnv("SM_EXECUTOR_DOCKER_BIN", "/bin/echo");
    vi.stubEnv("SM_CURSOR_BIN", "cursor");
    const exec = createExecutor("cursor");
    const r = await exec.run({
      workspacePath: "/tmp",
      prompt: "fix quickly",
      env: { SM_TEST: "1" }
    });
    expect(r.exitCode).toBe(0);
    expect(r.metadata.isolation).toBe("container");
    expect(r.metadata.runnerImage).toBe("acme/executor:latest");
    expect(r.metadata.command[0]).toBe("/bin/echo");
    expect(r.log).toContain("run --rm --network none");
    expect(r.log).toContain("acme/executor:latest cursor --prompt");
  });
});

describe("timeout behavior", () => {
  let tempDir: string;
  let slowScript: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sm-exec-timeout-"));
    slowScript = join(tempDir, "slow.sh");
    await writeFile(slowScript, "#!/bin/sh\nsleep 60\n");
    await chmod(slowScript, 0o755);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kills process after SM_EXECUTOR_TIMEOUT_MS", async () => {
    vi.stubEnv("SM_CURSOR_BIN", slowScript);
    vi.stubEnv("SM_EXECUTOR_TIMEOUT_MS", "500");
    const exec = createExecutor("cursor");
    const start = Date.now();
    const r = await exec.run({
      workspacePath: tempDir,
      prompt: "waiting",
      env: {}
    });
    const elapsed = Date.now() - start;
    expect(r.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(10_000);
    expect(r.metadata.simulated).toBe(false);
    expect(r.metadata.isolation).toBe("host");
  }, 15_000);
});
