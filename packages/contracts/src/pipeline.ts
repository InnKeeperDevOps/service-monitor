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

// Domains route an external host to a port already declared in `ports[]`.
// `protocol: https` is a *consumer-facing* protocol — the operator/ingress
// is responsible for TLS termination (cert, ALPN, HSTS); the container
// itself is reached over plain HTTP on the declared port. `protocol: http`
// disables TLS termination at the ingress (typical for internal-only
// hosts).
export const pipelineDomainSchema = z.object({
  /** External hostname. */
  host: z
    .string()
    .min(1)
    // RFC-1123-ish: labels of a-z0-9 + hyphens, separated by dots. Loose
    // enough to allow leading wildcards (`*.foo.com`) and uppercase.
    .regex(
      /^(\*\.)?([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/,
      "host must be a DNS-style hostname"
    ),
  /** Port number on the runtime container. MUST appear in `ports[]`. */
  port: z.number().int().min(1).max(65535),
  /** Consumer-facing protocol (TLS termination at the ingress). */
  protocol: z.enum(["http", "https"])
});

// Per-environment overrides. Both fields are optional; omitting either
// falls back to the top-level `instances` / `domains` defaults at deploy
// time.
export const pipelineEnvironmentSchema = z.object({
  /** Replica count for this environment. */
  instances: z.number().int().min(0).optional(),
  /** Domains routed to this environment. */
  domains: z.array(pipelineDomainSchema).default([])
});

// Environment names: lowercase alphanum + hyphen, max 63 chars (matches
// k8s namespace/label naming so future operator wiring stays simple).
const environmentNameRegex = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const pipelineDefinitionSchema = z
  .object({
    version: z.literal(PIPELINE_VERSION),
    build: pipelineBuildSchema.optional(),
    artifacts: z.array(safeRelativePath).default([]),
    runtime: pipelineRuntimeSchema.optional(),
    ports: z.array(pipelinePortSchema).default([]),
    /**
     * Default replica count when no environment-specific override
     * applies. 1 is the typical "single-instance dev service" default.
     * 0 is allowed (scaled-to-zero / pre-deploy state).
     */
    instances: z.number().int().min(0).default(1),
    /** Default domains routed to the runtime. */
    domains: z.array(pipelineDomainSchema).default([]),
    /**
     * Per-environment overrides. Keys are environment names
     * (e.g. "development", "staging", "production"). Each environment's
     * fields fall back to the top-level defaults when omitted.
     */
    environments: z.record(pipelineEnvironmentSchema).default({})
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
    // Cross-field validation: every domain.port (top-level OR per-env)
    // must reference a port declared in ports[]. The k8s/ingress operator
    // can't make up a port that wasn't exposed.
    const declared = new Set(def.ports.map((p) => p.port));
    if (declared.size > 0) {
      for (const [i, d] of def.domains.entries()) {
        if (!declared.has(d.port)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["domains", i, "port"],
            message: `domain port ${d.port} is not declared in ports[]`
          });
        }
      }
      for (const [envName, env] of Object.entries(def.environments)) {
        for (const [i, d] of env.domains.entries()) {
          if (!declared.has(d.port)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["environments", envName, "domains", i, "port"],
              message: `domain port ${d.port} is not declared in ports[]`
            });
          }
        }
      }
    } else if (def.domains.length > 0 || someEnvHasDomains(def.environments)) {
      // If domains exist anywhere, ports[] must be non-empty — otherwise
      // there's nothing to route to.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ports"],
        message: "domains require at least one entry in ports[]"
      });
    }

    // Environment names must match the simple k8s-style shape so the
    // operator can use them verbatim as namespace suffixes / label
    // values without further sanitisation.
    for (const envName of Object.keys(def.environments)) {
      if (!environmentNameRegex.test(envName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["environments", envName],
          message:
            `environment name "${envName}" must be lowercase alphanumeric with hyphens (max 63 chars)`
        });
      }
    }
  });

function someEnvHasDomains(envs: Record<string, { domains: unknown[] }>): boolean {
  for (const v of Object.values(envs)) {
    if (Array.isArray(v.domains) && v.domains.length > 0) return true;
  }
  return false;
}

export type PipelinePort = z.infer<typeof pipelinePortSchema>;
export type PipelineBuild = z.infer<typeof pipelineBuildSchema>;
export type PipelineRuntime = z.infer<typeof pipelineRuntimeSchema>;
export type PipelineDomain = z.infer<typeof pipelineDomainSchema>;
export type PipelineEnvironment = z.infer<typeof pipelineEnvironmentSchema>;
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

/**
 * Resolve the effective `instances` and `domains` for a given environment
 * name. Top-level fields are the defaults; per-env overrides win when
 * present. Returns the top-level defaults when the environment isn't in
 * the map.
 */
export function resolveEnvironment(
  def: PipelineDefinition,
  envName: string
): { instances: number; domains: PipelineDomain[] } {
  const env = def.environments[envName];
  return {
    instances: env?.instances ?? def.instances,
    domains: env?.domains.length ? env.domains : def.domains
  };
}

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
