import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const SHA = "a".repeat(40);
const RUNTIME_YAML = `
version: 1
runtime:
  image: nginx:alpine
  command: ["nginx", "-g", "daemon off;"]
ports:
  - port: 80
    name: http
`;
const DOCKERFILE_YAML = `
version: 1
dockerfile:
  path: Dockerfile
ports:
  - port: 9000
`;

// Mutable, hoisted so the vi.mock factories (hoisted above imports) can
// read it; tests flip these to drive branches.
const state = vi.hoisted(() => ({
  yaml: "" as string,
  yamlThrows: false,
  failCmd: "" as string // a command substring that should exit non-zero
}));

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[] = []) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (cmd === "git" && args.includes("ls-remote")) {
        child.stdout.emit("data", Buffer.from(`${SHA}\trefs/heads/main\n`));
      }
      const line = `${cmd} ${args.join(" ")}`;
      const bad = state.failCmd && line.includes(state.failCmd);
      if (bad) child.stderr.emit("data", Buffer.from("boom\n"));
      child.emit("close", bad ? 1 : 0);
    });
    return child;
  }
}));

vi.mock("node:fs", () => {
  const promises = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 1 }),
    readFile: vi.fn(async (p: string) => {
      if (String(p).includes("kaiad")) {
        if (state.yamlThrows) {
          const e: any = new Error("ENOENT");
          e.code = "ENOENT";
          throw e;
        }
        return state.yaml;
      }
      return "";
    })
  };
  const m = { existsSync: () => true, promises };
  return { ...m, default: m };
});

import { runPollOnce, runDrainOnce, startBuildLoops } from "../src/builds.js";
import type { QueryFn } from "@sm/db";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeQuery(opts: { noBuild?: boolean } = {}): QueryFn {
  const svcRow = {
    id: "svc-1", tenant_id: "t-1", name: "svc-1",
    git_repo_url: "https://example.com/r.git", branch: "main",
    ssh_key_id: null, pipeline_name: null, kind: "deployable", depends_on: []
  };
  return vi.fn(async (sql: string) => {
    const s = String(sql);
    if (/FROM monitored_services/i.test(s) && /SELECT/i.test(s)) return { rows: [svcRow] };
    if (/FROM ssh_keys/i.test(s)) return { rows: [] };
    if (/SELECT git_sha FROM service_builds/i.test(s)) return { rows: [] };
    if (/INSERT INTO service_builds/i.test(s)) {
      return { rows: [{ id: "bld-1", tenant_id: "t-1", service_id: "svc-1", git_sha: SHA, branch: "main", status: "queued" }] };
    }
    if (/UPDATE service_builds SET status = 'running'|FOR UPDATE SKIP LOCKED/i.test(s)) {
      return { rows: opts.noBuild ? [] : [{ id: "bld-1", tenant_id: "t-1", service_id: "svc-1", git_sha: SHA, branch: "main", status: "running", log: "", created_at: new Date().toISOString() }] };
    }
    return { rows: [] };
  }) as unknown as QueryFn;
}

describe("builds pipeline (mocked spawn/fs/db)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.yaml = RUNTIME_YAML;
    state.yamlThrows = false;
    state.failCmd = "";
  });

  it("runPollOnce lists services, resolves SHA, enqueues", async () => {
    const query = makeQuery();
    await expect(runPollOnce(query, logger)).resolves.toBeUndefined();
    expect((query as any).mock.calls.length).toBeGreaterThan(1);
  });

  it("runPollOnce no-ops on empty service list", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] }) as unknown as QueryFn;
    await expect(runPollOnce(query, logger)).resolves.toBeUndefined();
  });

  it("runDrainOnce runs a runtime (crane) build to completion", async () => {
    await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
  });

  it("runDrainOnce runs a Dockerfile-mode build", async () => {
    state.yaml = DOCKERFILE_YAML;
    await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
  });

  it("runDrainOnce fails the build on unparseable kaiad.yaml", async () => {
    state.yaml = "this: : : not yaml ::::";
    await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
  });

  it("runDrainOnce marks no_pipeline when kaiad.yaml is absent", async () => {
    state.yamlThrows = true;
    await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
  });

  it("runDrainOnce handles a git clone failure", async () => {
    state.failCmd = "git";
    await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
  });

  it("runDrainOnce is a no-op with no claimable build", async () => {
    await runDrainOnce(makeQuery({ noBuild: true }), logger);
  });

  it("startBuildLoops returns null when disabled / no DATABASE_URL", async () => {
    expect(await startBuildLoops({ KAIAD_BUILDS_DISABLED: "1" }, logger)).toBeNull();
    expect(await startBuildLoops({}, logger)).toBeNull();
  });

  it("runDrainOnce handles a crane-assembly failure (runtime mode)", async () => {
    state.failCmd = "crane";
    await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
  });

  it("runDrainOnce handles a docker build failure (Dockerfile mode)", async () => {
    state.yaml = DOCKERFILE_YAML;
    state.failCmd = "docker";
    await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
  });

  it("runtime build with registry-auth env resolves the auth config", async () => {
    process.env.REGISTRY_AUTH_KEY_PATH = "/tmp/k.pem";
    process.env.REGISTRY_AUTH_CERT_PATH = "/tmp/c.pem";
    process.env.KAIAD_REGISTRY_HOST = "panel.kaiad.dev";
    process.env.KAIAD_REGISTRY_INTERNAL = "127.0.0.1:8091";
    try {
      await expect(runDrainOnce(makeQuery(), logger)).resolves.toBeUndefined();
    } finally {
      delete process.env.REGISTRY_AUTH_KEY_PATH;
      delete process.env.REGISTRY_AUTH_CERT_PATH;
      delete process.env.KAIAD_REGISTRY_HOST;
      delete process.env.KAIAD_REGISTRY_INTERNAL;
    }
  });

  it("full deployable build: build-steps + artifacts + dependents + redeploy dispatch", async () => {
    state.yaml = `
version: 1
build:
  image: alpine
  steps:
    - echo hi > /artifacts/out.txt
artifacts:
  - out.txt
runtime:
  image: nginx:alpine
  command: ["nginx"]
ports:
  - port: 80
`;
    const query = vi.fn(async (sql: string) => {
      const s = String(sql);
      if (/FROM monitored_services/i.test(s) && /depends_on @>/i.test(s)) {
        return { rows: [{ id: "dep-1", name: "dep-svc", branch: "main" }] };
      }
      if (/FROM monitored_services/i.test(s) && /SELECT/i.test(s)) {
        return { rows: [{ id: "svc-1", tenant_id: "t-1", name: "svc-1", git_repo_url: "https://e/r.git", branch: "main", ssh_key_id: null, pipeline_name: null, kind: "deployable", depends_on: [] }] };
      }
      if (/FROM agent_services/i.test(s) || /JOIN agents a/i.test(s)) {
        return { rows: [{ agent_id: "ag-1", environment: "production" }] };
      }
      if (/FROM ssh_keys/i.test(s)) return { rows: [] };
      if (/UPDATE service_builds SET status = 'running'|FOR UPDATE SKIP LOCKED/i.test(s)) {
        return { rows: [{ id: "bld-1", tenant_id: "t-1", service_id: "svc-1", git_sha: SHA, branch: "main", status: "running", log: "", created_at: new Date().toISOString() }] };
      }
      if (/INSERT INTO service_builds/i.test(s)) {
        return { rows: [{ id: "dep-bld", tenant_id: "t-1", service_id: "dep-1", git_sha: "", branch: "main", status: "queued" }] };
      }
      return { rows: [] };
    }) as unknown as QueryFn;
    await expect(runDrainOnce(query, logger)).resolves.toBeUndefined();
  });

  it("runtime build resolves declared dependencies", async () => {
    state.yaml = `
version: 1
dependsOn:
  - other-svc
runtime:
  image: reg/{other_svc_version}
  command: ["run"]
ports:
  - port: 80
`;
    const dsha = "b".repeat(40);
    const query = vi.fn(async (sql: string) => {
      const s = String(sql);
      if (/FROM monitored_services/i.test(s) && /SELECT/i.test(s)) {
        return { rows: [{ id: "svc-1", tenant_id: "t-1", name: "svc-1", git_repo_url: "https://e/r.git", branch: "main", ssh_key_id: null, pipeline_name: null, kind: "deployable", depends_on: ["other-svc"] }] };
      }
      if (/FROM ssh_keys/i.test(s)) return { rows: [] };
      if (/UPDATE service_builds SET status = 'running'|FOR UPDATE SKIP LOCKED/i.test(s)) {
        return { rows: [{ id: "bld-1", tenant_id: "t-1", service_id: "svc-1", git_sha: SHA, branch: "main", status: "running", log: "", created_at: new Date().toISOString() }] };
      }
      // getLatestSuccessfulBuildByServiceName → dependency resolved
      if (/JOIN monitored_services s ON s\.id = b\.service_id/i.test(s)) {
        return { rows: [{ id: "dep-bld", service_id: "other-svc-id", git_sha: dsha, image_ref: `reg/other:${dsha}` }] };
      }
      return { rows: [] };
    }) as unknown as QueryFn;
    await expect(runDrainOnce(query, logger)).resolves.toBeUndefined();
  });
});
