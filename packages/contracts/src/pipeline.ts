// kaiad.yaml — the build pipeline definition that lives at the root of
// each service's git repo. The worker reads this on every new commit on
// the watched branch.
//
// Wire shape (intentional design choices):
//   - `build` runs inside `build.image` with /workspace=repo and
//     /artifacts=empty volume; steps are sequential shell commands.
//   - `runtime` is the image that gets pushed to kaiad's built-in
//     registry. Files captured from /artifacts are copied in.
//   - `ports` is the source of truth for service ports — kaiad does
//     NOT inspect the runtime image to discover ports.
//   - Everything except `version` is optional, so the simplest
//     possible pipeline is just an artifact-only build.
//
// Stability: bump `version` when making breaking changes; the parser
// hard-rejects unknown versions so old kaiad versions don't silently
// misinterpret newer schemas.

import { z } from "zod";
import yaml from "yaml";

export const PIPELINE_FILENAME = "kaiad.yaml";

/** Bump on breaking changes. v1 is the only supported version. */
const PIPELINE_VERSION = 1 as const;

// Path validation: relative, no `..` traversal. Used for artifact dest
// paths and runtime copy targets so a malicious kaiad.yaml can't
// reference paths outside the build context.
const safeRelativePath = z
  .string()
  .min(1)
  .refine((s) => !s.includes(".."), { message: "path may not contain '..'" })
  .refine((s) => !s.startsWith("/"), { message: "path must be relative" });

const portProtocolSchema = z.enum(["TCP", "UDP"]).default("TCP");

export const pipelinePortSchema = z.object({
  /** TCP/UDP port number exposed by the runtime image. */
  port: z.number().int().min(1).max(65535),
  /** Optional human-readable name (e.g. "http", "metrics"). */
  name: z.string().min(1).optional(),
  /** Wire protocol; defaults to TCP. */
  protocol: portProtocolSchema
});

export const pipelineCopySchema = z.object({
  /** Filename relative to /artifacts (must match an `artifacts:` entry). */
  from: safeRelativePath,
  /** Absolute path inside the runtime image where the file is placed. */
  to: z
    .string()
    .min(1)
    .startsWith("/", "runtime.copy.to must be absolute")
});

export const pipelineBuildSchema = z.object({
  /** Docker image used as the build environment. */
  image: z.string().min(1),
  /** Sequential shell commands. Each is run with `sh -c`. */
  steps: z.array(z.string().min(1)).min(1),
  /** Extra env vars exposed to all steps. */
  env: z.record(z.string()).default({})
});

export const pipelineRuntimeSchema = z.object({
  /**
   * Base image for the pushed runtime image. Defaults to "scratch" so
   * a single-static-binary build can omit it entirely.
   */
  image: z.string().min(1).default("scratch"),
  /** Files copied from /artifacts into the runtime image. */
  copy: z.array(pipelineCopySchema).default([]),
  /** Container entrypoint as an exec-form argv array. */
  command: z.array(z.string().min(1)).min(1)
});

export const pipelineDefinitionSchema = z
  .object({
    version: z.literal(PIPELINE_VERSION),
    build: pipelineBuildSchema.optional(),
    artifacts: z.array(safeRelativePath).default([]),
    runtime: pipelineRuntimeSchema.optional(),
    ports: z.array(pipelinePortSchema).default([])
  })
  .superRefine((def, ctx) => {
    // Cross-field validation: every runtime.copy.from MUST appear in
    // artifacts[]. Catches typos early instead of producing an empty
    // file in the runtime image.
    if (def.runtime) {
      const captured = new Set(def.artifacts);
      for (const c of def.runtime.copy) {
        if (!captured.has(c.from)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["runtime", "copy"],
            message: `runtime.copy.from "${c.from}" is not listed in artifacts[]`
          });
        }
      }
    }
    // If runtime is set, artifacts make sense too — otherwise the
    // runtime image is just `runtime.image` with the entrypoint set.
    // We don't reject that case (it's a legit "wrap an upstream image"
    // pattern) — just lint it via the API surface later if needed.
  });

export type PipelinePort = z.infer<typeof pipelinePortSchema>;
export type PipelineBuild = z.infer<typeof pipelineBuildSchema>;
export type PipelineRuntime = z.infer<typeof pipelineRuntimeSchema>;
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

export type PipelineParseResult =
  | { ok: true; pipeline: PipelineDefinition }
  | { ok: false; reason: string };

/**
 * Parse the YAML text of a kaiad.yaml file, then zod-validate the
 * resulting object. Returns a discriminated-union result so callers
 * can record the failure reason on the build row instead of throwing.
 */
export function parsePipelineYaml(text: string): PipelineParseResult {
  let raw: unknown;
  try {
    raw = yaml.parse(text);
  } catch (err) {
    return { ok: false, reason: `kaiad.yaml: invalid YAML — ${(err as Error).message}` };
  }
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "kaiad.yaml: root must be a mapping" };
  }
  const parsed = pipelineDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first.path.length > 0 ? first.path.join(".") : "<root>";
    return { ok: false, reason: `kaiad.yaml: ${path}: ${first.message}` };
  }
  return { ok: true, pipeline: parsed.data };
}
