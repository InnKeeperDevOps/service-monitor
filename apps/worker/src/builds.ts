// Build pipeline worker.
//
// Two long-running loops run inside @sm/worker (or embedded in the API
// container when SM_EMBED_WORKER=1):
//
//   Poller  — every BUILD_POLL_INTERVAL_MS, reads every MonitoredService,
//             does a `git ls-remote` to find the latest SHA on the watched
//             branch, and INSERTs a queued service_builds row if that SHA
//             hasn't been seen yet. The unique index on
//             (service_id, git_sha) makes this idempotent.
//
//   Builder — every BUILD_DRAIN_INTERVAL_MS, claims one queued row at a
//             time (FOR UPDATE SKIP LOCKED), clones at the SHA, reads
//             kaiad.yaml, runs the build container via the host docker
//             socket, captures artifacts, generates a runtime Dockerfile,
//             docker-builds + docker-pushes to kaiad's built-in registry.
//
// Why polling and not webhooks: works with the existing private-SSH-key
// flow without anyone needing to expose a public webhook URL or configure
// per-repo secrets in GitHub. Webhooks can be layered on later — they'd
// short-circuit by INSERTing the same service_builds row that this loop
// would have eventually produced.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── Local mirror of the API's SSH key encryption ──────────────────────────
// MUST match apps/api/src/postgresDomainStore.ts.{encryptSshKey,decryptSshKey}.
// The dev fallback ("dev-fallback-key" → sha256) keeps the worker working
// in compose without an explicit KAIAD_ENCRYPTION_KEY; production must set
// the env var and have it match the API's value.
function getEncryptionKey(): Buffer {
  const rawKey = process.env.KAIAD_ENCRYPTION_KEY;
  if (!rawKey) {
    return crypto.createHash("sha256").update("dev-fallback-key").digest();
  }
  if (rawKey.length === 64) return Buffer.from(rawKey, "hex");
  return crypto.createHash("sha256").update(rawKey).digest();
}

function decryptSshKey(stored: string): string | null {
  const parts = stored.split(":");
  if (parts.length !== 3) return null;
  try {
    const keyBytes = getEncryptionKey();
    const iv = Buffer.from(parts[0], "base64");
    const encrypted = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}
import { Pool } from "pg";
import {
  appendBuildLog,
  claimNextBuild,
  ensureCoreSchema,
  enqueueBuild,
  finishBuild,
  getLatestBuildSha,
  listAllServicesForPoller,
  recordBuildArtifact,
  setBuildPipelineYaml,
  updateBuildGitSha,
  type QueryFn,
  type ServiceBuildRow
} from "@sm/db";
import {
  parsePipelineYaml,
  resolveEnvironment,
  selectPipeline,
  type PipelineDefinition
} from "@sm/contracts";

// Tunables (env-overridable for tests).
const POLL_INTERVAL_MS = parseInt(process.env.BUILD_POLL_INTERVAL_MS ?? "60000", 10);
const DRAIN_INTERVAL_MS = parseInt(process.env.BUILD_DRAIN_INTERVAL_MS ?? "5000", 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.BUILD_TIMEOUT_MS ?? "1800000", 10); // 30 min default

// External hostname used in the image ref recorded in the DB and shown
// in the panel — what agent kubelets pull from.
const REGISTRY_HOST = process.env.KAIAD_REGISTRY_HOST ?? "panel.dev.kaiad.dev";
// Internal hostname the worker actually pushes to. Skips the
// openresty/nginx hop and avoids needing the host daemon to resolve
// compose DNS. Defaults to the external host if not set (single-host
// deployments without a separate registry container).
const REGISTRY_INTERNAL = process.env.KAIAD_REGISTRY_INTERNAL ?? REGISTRY_HOST;
// Whether the internal registry endpoint is plain HTTP. The compose
// dev stack runs the registry on plain HTTP between containers; flip
// to "0" if you've put the registry behind TLS.
const REGISTRY_INSECURE = process.env.KAIAD_REGISTRY_INSECURE !== "0";

const KAIAD_DATA_DIR = process.env.KAIAD_DATA_DIR ?? "/data";
// Where /data/builds resolves to on the HOST filesystem, so the build
// containers (spawned via the host docker daemon, NOT via this
// container's docker) can bind-mount the workspace directory. Compose
// sets this to ${PWD}/data/kaiad-builds; left as null when running
// the worker outside a docker compose context (unit tests, CI, etc.) —
// in that case the build step is skipped.
const BUILDS_HOST_DIR = process.env.KAIAD_BUILDS_HOST_DIR ?? null;

// Basic-auth credential for crane → /registry/token. Defaults match the
// dev compose stack's admin shortcut. Override in production via env so
// the worker pushes with a real admin credential.
const REGISTRY_PUSH_USER = process.env.KAIAD_REGISTRY_PUSH_USER ?? "admin";
const REGISTRY_PUSH_PASSWORD = process.env.KAIAD_REGISTRY_PUSH_PASSWORD ?? "dev-token";

type Logger = {
  info: (msg: string, ctx?: unknown) => void;
  warn: (msg: string, ctx?: unknown) => void;
  error: (msg: string, ctx?: unknown) => void;
};

const stderrLogger: Logger = {
  info: (m, c) => console.error(`[builds] ${m}`, c ?? ""),
  warn: (m, c) => console.error(`[builds][WARN] ${m}`, c ?? ""),
  error: (m, c) => console.error(`[builds][ERR] ${m}`, c ?? "")
};

export type BuildLoopHandles = {
  pollTimer: NodeJS.Timeout;
  drainTimer: NodeJS.Timeout;
  pool: Pool;
  stop: () => Promise<void>;
};

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Start the build pipeline loops. Returns null when DATABASE_URL is unset
 * (e.g. memory-store dev mode) or when the loops are explicitly disabled
 * with KAIAD_BUILDS_DISABLED=1.
 */
export async function startBuildLoops(
  env: NodeJS.ProcessEnv = process.env,
  logger: Logger = stderrLogger
): Promise<BuildLoopHandles | null> {
  if (env.KAIAD_BUILDS_DISABLED === "1") {
    logger.info("KAIAD_BUILDS_DISABLED=1 — build loops not started");
    return null;
  }
  if (!env.DATABASE_URL?.trim()) {
    logger.info("DATABASE_URL unset — build loops not started");
    return null;
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  await ensureCoreSchema(pool);

  const query: QueryFn = async (sql, params) => {
    const r = await pool.query(sql, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };

  let pollBusy = false;
  let drainBusy = false;

  const pollTimer = setInterval(() => {
    if (pollBusy) return;
    pollBusy = true;
    runPollOnce(query, logger)
      .catch((err) => logger.error("poll loop crashed", { err: String(err) }))
      .finally(() => {
        pollBusy = false;
      });
  }, POLL_INTERVAL_MS);

  const drainTimer = setInterval(() => {
    if (drainBusy) return;
    drainBusy = true;
    runDrainOnce(query, logger)
      .catch((err) => logger.error("drain loop crashed", { err: String(err) }))
      .finally(() => {
        drainBusy = false;
      });
  }, DRAIN_INTERVAL_MS);

  // Kick off a first poll immediately so freshly-deployed kaiad doesn't
  // wait 60s for the first run.
  setImmediate(() => {
    void runPollOnce(query, logger).catch(() => {
      /* logged inside */
    });
  });

  const stop = async () => {
    clearInterval(pollTimer);
    clearInterval(drainTimer);
    await pool.end();
  };

  logger.info("build loops started", {
    pollIntervalMs: POLL_INTERVAL_MS,
    drainIntervalMs: DRAIN_INTERVAL_MS,
    registryHost: REGISTRY_HOST
  });
  return { pollTimer, drainTimer, pool, stop };
}

// ─── Poller ───────────────────────────────────────────────────────────────

/**
 * One pass over every service. Errors per-service are isolated — one
 * unreachable repo doesn't stop the rest from being polled.
 */
export async function runPollOnce(query: QueryFn, logger: Logger): Promise<void> {
  const services = await listAllServicesForPoller(query);
  for (const svc of services) {
    try {
      const remoteSha = await gitLsRemoteHead(query, svc);
      if (!remoteSha) continue;
      const lastSha = await getLatestBuildSha(query, svc.id);
      if (lastSha === remoteSha) continue;
      const enq = await enqueueBuild(query, {
        tenantId: svc.tenantId,
        serviceId: svc.id,
        gitSha: remoteSha,
        branch: svc.branch
      });
      logger.info("queued build", {
        serviceId: svc.id,
        name: svc.name,
        sha: remoteSha.slice(0, 12),
        branch: svc.branch,
        buildId: enq.id
      });
    } catch (err) {
      // Don't surface every transient SSH failure — log once per pass and
      // move on. The next tick gets another shot.
      logger.warn("poll service failed", {
        serviceId: svc.id,
        name: svc.name,
        err: (err as Error).message
      });
    }
  }
}

/**
 * Resolve the latest SHA on the service's watched branch. Uses
 * `git ls-remote` rather than a clone — order of magnitude cheaper, and
 * works against private repos with the same SSH key the service is
 * configured with.
 */
async function gitLsRemoteHead(
  query: QueryFn,
  svc: { id: string; tenantId: string; gitRepoUrl: string; branch: string; sshKeyId: string | null }
): Promise<string | null> {
  const { keyFile, env } = await sshAuthEnvForKey(query, svc.tenantId, svc.sshKeyId);
  try {
    const res = await runProc("git", ["ls-remote", svc.gitRepoUrl, `refs/heads/${svc.branch}`], {
      env,
      timeoutMs: 30_000
    });
    if (res.code !== 0) {
      throw new Error(`git ls-remote exited ${res.code}: ${res.stderr.trim().slice(0, 400)}`);
    }
    const line = res.stdout.split("\n").find((l) => l.trim().length > 0);
    if (!line) return null;
    const sha = line.split(/\s+/)[0];
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } finally {
    if (keyFile) await fs.rm(keyFile, { force: true });
  }
}

// ─── Builder ──────────────────────────────────────────────────────────────

export async function runDrainOnce(query: QueryFn, logger: Logger): Promise<void> {
  // Process a single build per tick so a long build doesn't starve the
  // poll loop; we get back to drain on the next tick anyway.
  const build = await claimNextBuild(query);
  if (!build) return;
  try {
    await runBuild(query, build, logger);
  } catch (err) {
    logger.error("build crashed", {
      buildId: build.id,
      err: (err as Error).message
    });
    await safelyFailBuild(query, build.id, `worker crashed: ${(err as Error).message}`);
  }
}

async function runBuild(query: QueryFn, build: ServiceBuildRow, logger: Logger): Promise<void> {
  const startedAt = Date.now();
  const services = await listAllServicesForPoller(query);
  const svc = services.find((s) => s.id === build.serviceId);
  if (!svc) {
    await safelyFailBuild(query, build.id, "service deleted before build started");
    return;
  }

  // Manual builds are queued with an empty git_sha (the user clicked
  // "Start build" — they don't know or care about the exact SHA, they
  // just want HEAD of the watched branch). Resolve it now so the rest
  // of the build flow has a concrete SHA to pin to.
  if (!build.gitSha) {
    try {
      const head = await gitLsRemoteHead(query, svc);
      if (!head) {
        const reason = `git ls-remote returned no SHA for ${svc.gitRepoUrl}@${svc.branch}`;
        await safelyFailBuild(query, build.id, reason);
        return;
      }
      await updateBuildGitSha(query, build.id, head);
      build.gitSha = head;
      await appendBuildLog(query, build.id, `manual build resolved to ${svc.branch}@${head}\n`);
    } catch (err) {
      await safelyFailBuild(query, build.id, `git ls-remote failed: ${(err as Error).message}`);
      return;
    }
  }

  // The workspace directory lives under /data/builds/<id>/ specifically
  // because the host docker daemon needs to bind-mount the same path
  // when it spawns build containers. /data/builds is bound to
  // ${KAIAD_BUILDS_HOST_DIR} on the host; the worker uses the host path
  // for `-v` flags but the in-container path for its own filesystem ops.
  const buildsRoot = path.join(KAIAD_DATA_DIR, "builds");
  const root = path.join(buildsRoot, build.id);
  const ws = path.join(root, "workspace");
  const artifactsDir = path.join(root, "artifacts");
  // Host equivalents (used only for docker -v flags).
  const hostRoot = BUILDS_HOST_DIR ? path.join(BUILDS_HOST_DIR, build.id) : null;
  const hostWs = hostRoot ? path.join(hostRoot, "workspace") : null;
  const hostArtifacts = hostRoot ? path.join(hostRoot, "artifacts") : null;
  await fs.mkdir(ws, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });

  await appendBuildLog(
    query,
    build.id,
    banner(
      `${build.triggeredBy === "manual" ? "MANUAL " : ""}build #${build.id.slice(0, 8)} ${svc.name}@${build.gitSha.slice(0, 12)}`
    )
  );

  try {
    // 1) Clone at the exact SHA.
    await cloneAtSha(query, svc, build, ws);

    // 2) Read kaiad.yaml. Missing file → no_pipeline (not red).
    const yamlPath = path.join(ws, "kaiad.yaml");
    let yamlText: string;
    try {
      yamlText = await fs.readFile(yamlPath, "utf8");
    } catch {
      await appendBuildLog(query, build.id, "kaiad.yaml not found at repo root — skipping build\n");
      await finishBuild(query, build.id, { status: "no_pipeline" });
      return;
    }
    await setBuildPipelineYaml(query, build.id, yamlText);

    const parsed = parsePipelineYaml(yamlText);
    if (!parsed.ok) {
      await appendBuildLog(query, build.id, `${parsed.reason}\n`);
      await finishBuild(query, build.id, { status: "failed", failureReason: parsed.reason });
      return;
    }
    // Multi-pipeline kaiad.yaml: pick the slice this MonitoredService is
    // bound to via pipelineName. Single-pipeline yamls return their lone
    // pipeline regardless of pipelineName.
    const picked = selectPipeline(parsed, svc.pipelineName ?? null);
    if (!picked.ok) {
      await appendBuildLog(query, build.id, `${picked.reason}\n`);
      await finishBuild(query, build.id, { status: "failed", failureReason: picked.reason });
      return;
    }
    const pipeline = picked.pipeline;

    // 3) Run the build container, if defined. Requires KAIAD_BUILDS_HOST_DIR
    //    so the spawned container can see the same workspace.
    if (pipeline.build) {
      if (!hostWs || !hostArtifacts) {
        const reason =
          "KAIAD_BUILDS_HOST_DIR is not set; build steps require a shared host bind mount " +
          "so the spawned container can see the workspace. Set it in the compose env.";
        await appendBuildLog(query, build.id, `${reason}\n`);
        await finishBuild(query, build.id, { status: "failed", failureReason: reason });
        return;
      }
      await appendBuildLog(query, build.id, banner(`build stage — image=${pipeline.build.image}`));
      const buildOk = await runBuildContainer({
        query,
        buildId: build.id,
        hostWs,
        hostArtifacts,
        pipeline,
        sha: build.gitSha,
        branch: build.branch,
        serviceName: svc.name
      });
      if (!buildOk.ok) {
        await finishBuild(query, build.id, { status: "failed", failureReason: buildOk.reason });
        return;
      }
    }

    // 4) Capture artifacts.
    const captured = await captureArtifacts(query, build.id, artifactsDir, pipeline.artifacts);
    if (!captured.ok) {
      await finishBuild(query, build.id, { status: "failed", failureReason: captured.reason });
      return;
    }

    // 5) Build + push runtime image (if defined).
    let imageRef: string | null = null;
    if (pipeline.runtime) {
      const built = await buildRuntimeImage({
        query,
        buildId: build.id,
        rootDir: root,
        artifactsDir,
        pipeline,
        serviceName: svc.name,
        sha: build.gitSha
      });
      if (!built.ok) {
        await finishBuild(query, build.id, { status: "failed", failureReason: built.reason });
        return;
      }
      imageRef = built.imageRef;
    } else {
      await appendBuildLog(query, build.id, "no runtime: section — skipping image build\n");
    }

    await appendBuildLog(query, build.id, `done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
    await finishBuild(query, build.id, { status: "success", imageRef });
    logger.info("build succeeded", { buildId: build.id, sha: build.gitSha.slice(0, 12), imageRef });

    // Manual builds emit a redeploy_service command to every bound
    // agent on success. Stub: the agent acknowledges the dispatch but
    // doesn't yet pull/recreate (per-runtime handler is a follow-up).
    if (build.triggeredBy === "manual" && imageRef) {
      await dispatchRedeployToBoundAgents(
        query,
        build.id,
        build.serviceId,
        imageRef,
        pipeline,
        logger
      ).catch((err) => {
        logger.warn("redeploy dispatch failed", {
          buildId: build.id,
          err: (err as Error).message
        });
      });
    }
  } finally {
    // Best-effort cleanup. /tmp gets reaped on container restart anyway,
    // but leaving 1 GB of node_modules around per build adds up.
    fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Build container runner ────────────────────────────────────────────────

async function runBuildContainer(params: {
  query: QueryFn;
  buildId: string;
  /** Path on the HOST to the build's workspace dir. */
  hostWs: string;
  /** Path on the HOST to the build's artifacts dir. */
  hostArtifacts: string;
  pipeline: PipelineDefinition;
  sha: string;
  branch: string;
  serviceName: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { query, buildId, hostWs, hostArtifacts, pipeline, sha, branch, serviceName } = params;
  if (!pipeline.build) return { ok: true };

  const envArgs = Object.entries(pipeline.build.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const stepScript = pipeline.build.steps
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n");

  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    `${hostWs}:/workspace`,
    "-v",
    `${hostArtifacts}:/artifacts`,
    "-w",
    "/workspace",
    "-e",
    `GIT_SHA=${sha}`,
    "-e",
    `GIT_BRANCH=${branch}`,
    "-e",
    `KAIAD_SERVICE_NAME=${serviceName}`,
    ...envArgs,
    pipeline.build.image,
    // `set -euo pipefail` so a step failure stops the build immediately;
    // newline-joined so each user step can be a multi-command line.
    "sh",
    "-c",
    `set -eu\n${stepScript}`
  ];

  const res = await runProcStreaming("docker", dockerArgs, {
    onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
    timeoutMs: BUILD_TIMEOUT_MS
  });
  if (res.code !== 0) {
    return { ok: false, reason: `build step exited with code ${res.code}` };
  }
  return { ok: true };
}

// ─── Artifact capture ──────────────────────────────────────────────────────

async function captureArtifacts(
  query: QueryFn,
  buildId: string,
  artifactsDir: string,
  wanted: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (wanted.length === 0) return { ok: true };
  const dest = path.join(KAIAD_DATA_DIR, "builds", buildId);
  await fs.mkdir(dest, { recursive: true });

  for (const name of wanted) {
    const src = path.join(artifactsDir, name);
    let stat: import("fs").Stats;
    try {
      stat = await fs.stat(src);
    } catch {
      return { ok: false, reason: `artifact "${name}" not produced under /artifacts` };
    }
    if (!stat.isFile()) {
      return { ok: false, reason: `artifact "${name}" is not a regular file` };
    }
    const data = await fs.readFile(src);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const safeRel = name.replace(/[^A-Za-z0-9._-]/g, "_");
    const finalDst = path.join(dest, safeRel);
    await fs.writeFile(finalDst, data);
    await recordBuildArtifact(query, {
      buildId,
      name,
      sizeBytes: data.length,
      sha256,
      relPath: safeRel
    });
    await appendBuildLog(query, buildId, `captured artifact ${name} (${data.length} bytes)\n`);
  }
  return { ok: true };
}

// ─── Runtime image build + push ────────────────────────────────────────────

/**
 * Assemble + push the runtime image without going through the host
 * docker daemon. We use crane (already baked into the kaiad image for
 * the agent push-on-boot flow) for three reasons:
 *
 *   1) crane runs inside the kaiad container, so it can resolve compose
 *      DNS names like `registry:5000` — the host docker daemon can't.
 *   2) The build artifacts produced by the build step live INSIDE the
 *      kaiad container (under /data/builds). Asking host docker to
 *      `docker build` would require the artifacts to also exist on the
 *      host filesystem, which only works because of the bind mount;
 *      crane reads them directly without that detour.
 *   3) The auth flow (~/.docker/config.json with `registrytoken`) is
 *      already set up by push-agent-on-boot.sh; crane reuses it.
 *
 * Layer construction:
 *   /tmp/build/<id>/layer-root/<runtime.copy[].to>  (mirrors the absolute
 *                                                    path each artifact
 *                                                    will appear at)
 *   tar -C layer-root -cf layer.tar .
 *   crane append --base <runtime.image> --new_layer layer.tar
 *                --new_tag <ref>          # pushes directly to registry
 *   crane mutate <ref> --entrypoint=<...> --exposed-ports=<...>
 *                --tag <ref>              # mutates in-registry, overwrite tag
 *   crane tag <ref> latest                # moves :latest pointer
 *
 * Note crane mutate's first positional is an image REFERENCE, not a
 * tarball — feeding it a /path/to/tarball ends up interpreted as
 * `index.docker.io/path/to/tarball:latest` and 401s. The append step
 * therefore must push first.
 */
async function buildRuntimeImage(params: {
  query: QueryFn;
  buildId: string;
  rootDir: string;
  artifactsDir: string;
  pipeline: PipelineDefinition;
  serviceName: string;
  sha: string;
}): Promise<{ ok: true; imageRef: string } | { ok: false; reason: string }> {
  const { query, buildId, rootDir, artifactsDir, pipeline, serviceName, sha } = params;
  const runtime = pipeline.runtime!;

  // crane mutate uses `,` as a separator inside --entrypoint. Reject
  // entrypoint args that contain a comma so we don't silently corrupt
  // the runtime command.
  for (const arg of runtime.command) {
    if (arg.includes(",")) {
      return {
        ok: false,
        reason: `runtime.command arg "${arg}" contains a comma, which crane mutate cannot disambiguate`
      };
    }
  }

  await appendBuildLog(query, buildId, banner("runtime image (crane assembly)"));

  // 0) Per-build docker config with Basic auth so crane runs the
  //    /registry/token round-trip per push and gets a JWT scoped to
  //    THIS repo. The container-wide ~/.docker/config.json is set up
  //    by push-agent-on-boot.sh with a `registrytoken` Bearer scoped
  //    only to `kaiad-agent`, which would 401 here. We don't touch
  //    that config — we use a separate DOCKER_CONFIG dir per build.
  const dockerCfgDir = path.join(rootDir, "docker-config");
  await fs.mkdir(dockerCfgDir, { recursive: true });
  const basic = Buffer.from(`${REGISTRY_PUSH_USER}:${REGISTRY_PUSH_PASSWORD}`).toString("base64");
  await fs.writeFile(
    path.join(dockerCfgDir, "config.json"),
    JSON.stringify(
      {
        auths: {
          [REGISTRY_INTERNAL]: { auth: basic },
          [REGISTRY_HOST]: { auth: basic }
        }
      },
      null,
      2
    )
  );
  const craneEnv = { ...process.env, DOCKER_CONFIG: dockerCfgDir };

  const internalRef = `${REGISTRY_INTERNAL}/${serviceName}:${sha}`;
  const internalLatestRef = `${REGISTRY_INTERNAL}/${serviceName}:latest`;
  // Image ref recorded in the DB / shown in the panel. Uses the
  // EXTERNAL hostname agents pull from. The actual blobs are the same.
  const externalRef = `${REGISTRY_HOST}/${serviceName}:${sha}`;

  // Collect every layer we need to append in order. crane append takes
  // ONE new_layer per call, so multiple layers are chained through
  // tarball outputs. The order is: copy-derived layer first (if any
  // runtime.copy entries) then each entry in runtime.layers in order.
  const layersToAppend: string[] = [];

  if (runtime.copy.length > 0) {
    const layerRoot = path.join(rootDir, "layer-root");
    await fs.mkdir(layerRoot, { recursive: true });
    for (const c of runtime.copy) {
      const src = path.join(artifactsDir, c.from);
      // c.to is an absolute path inside the runtime image. Strip the
      // leading slash so the tar entries are relative to the rootfs.
      const dst = path.join(layerRoot, c.to.replace(/^\/+/, ""));
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    }
    const copyLayerTar = path.join(rootDir, "copy-layer.tar");
    const tarRes = await runProcStreaming("tar", ["-C", layerRoot, "-cf", copyLayerTar, "."], {
      onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
      timeoutMs: 60_000
    });
    if (tarRes.code !== 0) {
      return { ok: false, reason: `tar (copy layer) exited with code ${tarRes.code}` };
    }
    layersToAppend.push(copyLayerTar);
  }

  for (const layerName of runtime.layers) {
    layersToAppend.push(path.join(artifactsDir, layerName));
  }

  // Chain crane append calls through intermediate tarballs. Each call
  // takes the previous result as `--base` and writes the next tarball
  // via `--output`. After the last layer, `crane push` ships the
  // final tarball to <internalRef>.
  let prevBase: string = runtime.image; // first iteration uses the registry base
  for (let i = 0; i < layersToAppend.length; i++) {
    const stagePath = path.join(rootDir, `stage-${i}.tar`);
    const appendArgs = [
      ...(REGISTRY_INSECURE ? ["--insecure"] : []),
      "append",
      "--base",
      prevBase,
      "--new_layer",
      layersToAppend[i],
      "--new_tag",
      internalRef,
      "--output",
      stagePath
    ];
    const appendRes = await runProcStreaming("crane", appendArgs, {
      env: craneEnv,
      onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
      timeoutMs: BUILD_TIMEOUT_MS
    });
    if (appendRes.code !== 0) {
      return {
        ok: false,
        reason: `crane append (stage ${i}) exited with code ${appendRes.code}`
      };
    }
    prevBase = stagePath;
  }

  if (layersToAppend.length === 0) {
    // No layers to add — just tag the base image as <internalRef> so
    // mutate has something to operate on. crane copy is registry-to-
    // registry, which is what we want.
    const copyArgs = [
      ...(REGISTRY_INSECURE ? ["--insecure"] : []),
      "copy",
      runtime.image,
      internalRef
    ];
    const copyRes = await runProcStreaming("crane", copyArgs, {
      env: craneEnv,
      onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
      timeoutMs: BUILD_TIMEOUT_MS
    });
    if (copyRes.code !== 0) {
      return { ok: false, reason: `crane copy ${runtime.image} → <ref> exited ${copyRes.code}` };
    }
  } else {
    // Push the final-stage tarball to the registry so mutate can pull
    // it back by ref.
    const pushArgs = [
      ...(REGISTRY_INSECURE ? ["--insecure"] : []),
      "push",
      prevBase,
      internalRef
    ];
    const pushRes = await runProcStreaming("crane", pushArgs, {
      env: craneEnv,
      onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
      timeoutMs: BUILD_TIMEOUT_MS
    });
    if (pushRes.code !== 0) {
      return { ok: false, reason: `crane push (final stage) exited with code ${pushRes.code}` };
    }
  }

  // 3) crane mutate — pull the just-pushed image, set entrypoint +
  //    exposed ports, push back to the same tag.
  const mutateArgs: string[] = [
    ...(REGISTRY_INSECURE ? ["--insecure"] : []),
    "mutate",
    internalRef,
    "--tag",
    internalRef,
    `--entrypoint=${runtime.command.join(",")}`
  ];
  for (const p of pipeline.ports) {
    mutateArgs.push(`--exposed-ports=${p.port}/${p.protocol.toLowerCase()}`);
  }
  const mutateRes = await runProcStreaming("crane", mutateArgs, {
    env: craneEnv,
    onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
    timeoutMs: BUILD_TIMEOUT_MS
  });
  if (mutateRes.code !== 0) {
    return { ok: false, reason: `crane mutate exited with code ${mutateRes.code}` };
  }

  const tagArgs = [
    ...(REGISTRY_INSECURE ? ["--insecure"] : []),
    "tag",
    internalRef,
    "latest"
  ];
  const tagRes = await runProcStreaming("crane", tagArgs, {
    env: craneEnv,
    onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
    timeoutMs: BUILD_TIMEOUT_MS
  });
  if (tagRes.code !== 0) {
    // Non-fatal: the immutable tag already pushed; missing :latest is
    // a degraded but recoverable state.
    await appendBuildLog(
      query,
      buildId,
      `WARNING: crane tag ${internalLatestRef} exited ${tagRes.code} — :latest may not move\n`
    );
  }

  return { ok: true, imageRef: externalRef };
}

// ─── Git clone helper ──────────────────────────────────────────────────────

async function cloneAtSha(
  query: QueryFn,
  svc: { id: string; tenantId: string; gitRepoUrl: string; sshKeyId: string | null },
  build: ServiceBuildRow,
  ws: string
): Promise<void> {
  const { keyFile, env } = await sshAuthEnvForKey(query, svc.tenantId, svc.sshKeyId);
  try {
    await appendBuildLog(query, build.id, `cloning ${svc.gitRepoUrl} @ ${build.gitSha.slice(0, 12)}\n`);
    // Two-step: shallow init + fetch the exact SHA. Faster than a full
    // clone and works even when the SHA is no longer at branch head.
    await runOrThrow(query, build.id, "git", ["init", "-q"], { cwd: ws, env });
    await runOrThrow(query, build.id, "git", ["remote", "add", "origin", svc.gitRepoUrl], {
      cwd: ws,
      env
    });
    await runOrThrow(
      query,
      build.id,
      "git",
      ["fetch", "--depth=1", "origin", build.gitSha],
      { cwd: ws, env, timeoutMs: 300_000 }
    );
    await runOrThrow(query, build.id, "git", ["checkout", "-q", build.gitSha], { cwd: ws, env });
  } finally {
    if (keyFile) await fs.rm(keyFile, { force: true });
  }
}

async function runOrThrow(
  query: QueryFn,
  buildId: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<void> {
  const res = await runProcStreaming(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    onChunk: (chunk) => appendBuildLog(query, buildId, chunk),
    timeoutMs: opts.timeoutMs
  });
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.code}`);
  }
}

// ─── SSH key resolution ────────────────────────────────────────────────────

/**
 * Materialize the service's SSH key (if any) into a tmpfile and return
 * an env that points GIT_SSH_COMMAND at it. Caller is responsible for
 * unlinking `keyFile` when done — see usage in cloneAtSha / gitLsRemoteHead.
 *
 * For `local_path` keys we just point GIT_SSH_COMMAND at the existing
 * file; no tmpfile is materialized. For uploaded keys we write a 0600
 * tmpfile so ssh's strict perms check doesn't refuse it.
 */
async function sshAuthEnvForKey(
  query: QueryFn,
  tenantId: string,
  sshKeyId: string | null
): Promise<{ keyFile: string | null; env: NodeJS.ProcessEnv }> {
  if (!sshKeyId) {
    return { keyFile: null, env: { ...process.env } };
  }
  const { rows } = await query(
    `SELECT type, private_key_encrypted, local_path FROM ssh_keys WHERE tenant_id = $1 AND id = $2`,
    [tenantId, sshKeyId]
  );
  if (rows.length === 0) {
    return { keyFile: null, env: { ...process.env } };
  }
  const row = rows[0];
  let keyFile: string | null = null;
  let identity: string | null = null;
  if (String(row.type) === "local_path" && row.local_path) {
    identity = String(row.local_path);
  } else if (row.private_key_encrypted) {
    // The API encrypts uploaded keys before storage with AES-256-GCM
    // (see apps/api/src/postgresDomainStore.ts). The stored value is
    // `<iv-b64>:<ciphertext-b64>:<tag-b64>` — decrypt with the same
    // KAIAD_ENCRYPTION_KEY so we can hand a real OpenSSH key to ssh.
    const decrypted = decryptSshKey(String(row.private_key_encrypted));
    if (!decrypted) {
      // Refuse to write garbage that ssh would reject anyway. Caller
      // sees a clearer "permission denied" with this in the build log.
      throw new Error(
        "ssh key decrypt failed (KAIAD_ENCRYPTION_KEY mismatch with the API that uploaded it?)"
      );
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kaiad-ssh-"));
    keyFile = path.join(dir, "id");
    let body = decrypted;
    // OpenSSH refuses keys without a trailing newline.
    if (!body.endsWith("\n")) body += "\n";
    await fs.writeFile(keyFile, body, { mode: 0o600 });
    identity = keyFile;
  }
  const env = { ...process.env };
  if (identity) {
    env.GIT_SSH_COMMAND = `ssh -i ${identity} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  }
  return { keyFile, env };
}

// ─── Process spawn helpers ─────────────────────────────────────────────────

type ProcResult = { code: number; stdout: string; stderr: string };

function runProc(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    const t = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (t) clearTimeout(t);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
    child.on("error", (e) => {
      if (t) clearTimeout(t);
      resolve({ code: -1, stdout: out, stderr: `${err}\nspawn error: ${e.message}` });
    });
  });
}

function runProcStreaming(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onChunk: (chunk: string) => Promise<void> | void;
    timeoutMs?: number;
  }
): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const flush = (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s) {
        Promise.resolve(opts.onChunk(s)).catch(() => {
          /* logging into the build row is best-effort */
        });
      }
    };
    child.stdout.on("data", flush);
    child.stderr.on("data", flush);
    const t = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (t) clearTimeout(t);
      resolve({ code: code ?? -1 });
    });
    child.on("error", (e) => {
      if (t) clearTimeout(t);
      Promise.resolve(opts.onChunk(`spawn error: ${e.message}\n`)).catch(() => {});
      resolve({ code: -1 });
    });
  });
}

// ─── Misc helpers ──────────────────────────────────────────────────────────

// ─── Manual-build redeploy dispatch ────────────────────────────────────────

/**
 * Send a redeploy_service agent command to every agent bound to this
 * service. We POST to the API's existing /api/v1/internal/agent-commands
 * endpoint rather than reach into the realtime manager directly — the
 * worker may run in its own process (SM_EMBED_WORKER=0) and the API is
 * the canonical dispatch surface.
 *
 * The agent-side handler is currently a stub (see apps/agent/internal/
 * executor/executor.go:case "redeploy_service"); it acks the command
 * but doesn't yet pull/recreate. The dispatch round-trip is wired now
 * so the panel surfaces "redeploy dispatched" and so the per-runtime
 * handlers (docker pull+recreate; kubectl rollout restart) have a
 * stable command shape to land against.
 */
async function dispatchRedeployToBoundAgents(
  query: QueryFn,
  buildId: string,
  serviceId: string,
  imageRef: string,
  pipeline: PipelineDefinition,
  logger: Logger
): Promise<void> {
  const apiUrl = process.env.INTERNAL_API_URL?.trim() ?? `http://127.0.0.1:${process.env.PORT ?? "8092"}`;
  const internalToken = (process.env.INTERNAL_API_TOKEN?.trim() || "dev-token");

  // Join agent_services with agents so we know each bound agent's
  // environment up-front. The operator/agent uses it to pick the
  // right per-env block from the pipeline.
  const { rows } = await query(
    `SELECT a.id AS agent_id, a.environment
       FROM agent_services s
       JOIN agents a ON a.id = s.agent_id
      WHERE s.service_id = $1`,
    [serviceId]
  );
  if (rows.length === 0) {
    await appendBuildLog(query, buildId, "no agents bound to this service — skipping redeploy dispatch\n");
    return;
  }

  await appendBuildLog(
    query,
    buildId,
    banner(`redeploy_service → ${rows.length} bound agent(s)`)
  );

  for (const row of rows) {
    const agentId = String(row.agent_id);
    const agentEnv = String(row.environment ?? "development");
    const resolved = resolveEnvironment(pipeline, agentEnv);
    const commandId = crypto.randomUUID();
    const job = {
      agentId,
      commandId,
      payload: {
        type: "redeploy_service",
        commandId,
        serviceId,
        imageRef,
        buildId,
        // Per-agent resolved deployment metadata. Agents/operators in
        // different environments get different instances/domains/
        // loadBalancer values for the same image.
        environment: agentEnv,
        instances: resolved.instances,
        domains: resolved.domains,
        loadBalancer: resolved.loadBalancer
      }
    };
    try {
      const res = await fetch(`${apiUrl}/api/v1/internal/agent-commands`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${internalToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(job)
      });
      const bodyText = await res.text();
      if (!res.ok) {
        await appendBuildLog(
          query,
          buildId,
          `  ${agentId.slice(0, 32)} [env=${agentEnv}]: dispatch ${res.status} — ${bodyText.slice(0, 200)}\n`
        );
        logger.warn("redeploy dispatch non-2xx", { buildId, agentId, status: res.status });
        continue;
      }
      // /agent-commands responds with { delivered, queued }.
      let parsed: { delivered?: boolean; queued?: boolean } = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        /* ignore */
      }
      const where = parsed.delivered ? "delivered (online)" : parsed.queued ? "queued (offline)" : "accepted";
      await appendBuildLog(
        query,
        buildId,
        `  ${agentId.slice(0, 32)} [env=${agentEnv} replicas=${resolved.instances}]: ${where}\n`
      );
    } catch (err) {
      await appendBuildLog(
        query,
        buildId,
        `  ${agentId.slice(0, 32)}: dispatch failed — ${(err as Error).message}\n`
      );
      logger.warn("redeploy dispatch error", { buildId, agentId, err: (err as Error).message });
    }
  }
}

async function safelyFailBuild(query: QueryFn, buildId: string, reason: string): Promise<void> {
  try {
    await appendBuildLog(query, buildId, `\n${reason}\n`);
    await finishBuild(query, buildId, { status: "failed", failureReason: reason });
  } catch {
    /* best effort */
  }
}

function banner(text: string): string {
  const bar = "─".repeat(Math.max(2, 70 - text.length));
  return `\n── ${text} ${bar}\n`;
}

