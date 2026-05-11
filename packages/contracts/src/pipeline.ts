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

// Alternative build mode: just point at a Dockerfile. Kaiad runs
// `docker build` on the host daemon and pushes the result to the
// built-in registry. Mutually exclusive with build/artifacts/runtime —
// the Dockerfile already encodes everything those would describe.
//
// `ports`, `instances`, `domains`, `environments`, `loadBalancer` still
// apply: those are deployment-time metadata, independent of how the
// image is produced.
export const pipelineDockerfileSchema = z.object({
  /** Path to the Dockerfile, relative to the repo root. */
  path: z.string().min(1).default("Dockerfile"),
  /** Build context, relative to the repo root. */
  context: z.string().min(1).default("."),
  /** --build-arg map. */
  args: z.record(z.string()).default({}),
  /** --target stage for multi-stage builds. */
  target: z.string().min(1).optional()
});

export const pipelineRuntimeSchema = z.object({
  /**
   * Base image for the pushed runtime image. Defaults to "scratch" so
   * a single-static-binary build can omit it entirely.
   */
  image: z.string().min(1).default("scratch"),
  /** Files copied from /artifacts into the runtime image. */
  copy: z.array(pipelineCopySchema).default([]),
  /**
   * Tar archives produced by the build step that should be appended
   * verbatim as filesystem layers. Each entry is the name of an
   * artifact (must appear in `artifacts:`); the tar's contents are
   * unpacked into the runtime image at the paths the tar declares.
   * Used when copying many files (e.g. an entire PHP project tree)
   * is more practical than enumerating each in `copy:`.
   */
  layers: z.array(safeRelativePath).default([]),
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

// External load-balancer hint for the deploying operator. Different
// clusters expose services very differently — MetalLB does ARP/BGP
// LoadBalancer IPs on bare metal, ingress-nginx terminates HTTPS via
// Ingress resources, default k8s emits Service.type=LoadBalancer and
// lets the cloud provider handle the rest. The operator generates
// the right manifests based on `type`. v1: this is metadata stored
// on the build row; the operator consumer is a follow-up.
export const pipelineLoadBalancerSchema = z.discriminatedUnion("type", [
  // Cluster-internal only — no external surface. Default.
  z.object({
    type: z.literal("none")
  }),
  // Service.type=LoadBalancer with no special annotations. The cloud
  // provider's controller (AWS ELB / GCP NLB / etc.) provisions the
  // external LB. Falls flat on bare-metal clusters with no provider —
  // use `metallb` there instead.
  z.object({
    type: z.literal("k8s"),
    /** Free-form annotations applied to the Service. */
    annotations: z.record(z.string()).default({})
  }),
  // MetalLB (bare-metal IPAM controller). Service.type=LoadBalancer
  // with a `metallb.universe.tf/address-pool` annotation when
  // addressPool is set; otherwise MetalLB picks from any pool.
  z.object({
    type: z.literal("metallb"),
    /** Address pool name. Sets the metallb.universe.tf/address-pool annotation. */
    addressPool: z.string().min(1).optional()
  }),
  // ingress-nginx. Service.type=ClusterIP; Ingress resource per host
  // with `ingressClassName: nginx` (or whatever `ingressClass` overrides
  // it to). When tlsSecret is set, the Ingress includes a `tls:` block
  // referencing it; otherwise the operator picks (e.g. cert-manager).
  z.object({
    type: z.literal("nginx"),
    /** ingressClassName. Defaults to "nginx". */
    ingressClass: z.string().min(1).default("nginx"),
    /** Existing TLS Secret to reference in the Ingress's tls block. */
    tlsSecret: z.string().min(1).optional()
  })
]);

// Kubernetes namespace / docker grouping name. Validated as an
// RFC-1123-style label so it round-trips into k8s namespace names
// directly. Same shape as environment + pipeline names.
const namespaceRegex = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const namespaceSchema = z
  .string()
  .regex(namespaceRegex, "namespace must be lowercase alphanumeric with hyphens (max 63 chars)");

// Per-environment overrides. All fields are optional; omitting any falls
// back to the top-level default at deploy time.
export const pipelineEnvironmentSchema = z.object({
  /** Replica count for this environment. */
  instances: z.number().int().min(0).optional(),
  /** Domains routed to this environment. */
  domains: z.array(pipelineDomainSchema).default([]),
  /** Load-balancer override for this environment. */
  loadBalancer: pipelineLoadBalancerSchema.optional(),
  /**
   * Kubernetes namespace this environment deploys into (or docker
   * "project name" — the agent uses it to scope container names and
   * labels). Overrides the top-level default.
   */
  namespace: namespaceSchema.optional()
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
    /**
     * Alternative build mode — exclusive with build/artifacts/runtime.
     * When set, kaiad runs `docker build` on the host daemon and pushes
     * the resulting image to its built-in registry. Image config
     * (entrypoint, exposed ports, env, etc.) comes from the Dockerfile.
     */
    dockerfile: pipelineDockerfileSchema.optional(),
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
     * Default load balancer. Per-env can override; otherwise the
     * operator uses this. Defaults to {type: "none"} (cluster-internal).
     */
    loadBalancer: pipelineLoadBalancerSchema.default({ type: "none" }),
    /**
     * Default kubernetes namespace / docker project name. Per-env can
     * override. When unset, the agent picks: in k8s mode, the agent's
     * own pod namespace; in docker mode, the literal "kaiad".
     */
    namespace: namespaceSchema.optional(),
    /**
     * Per-environment overrides. Keys are environment names
     * (e.g. "development", "staging", "production"). Each environment's
     * fields fall back to the top-level defaults when omitted.
     */
    environments: z.record(pipelineEnvironmentSchema).default({}),
    /**
     * Service "kind".
     *   - "deployable" (default): the build produces a runtime image
     *     the platform deploys to bound agents.
     *   - "supporting": the build produces an artifact (typically a
     *     base/library docker image) consumed by other services'
     *     builds. Supporting services are NOT dispatched to agents
     *     even when bound — they sit upstream of `dependsOn`.
     */
    kind: z.enum(["deployable", "supporting"]).default("deployable"),
    /**
     * Names of other Kaiad services this one needs to have built
     * first. Resolution is tenant-scoped by MonitoredService.name.
     * After each dep's latest successful build is found, build-time
     * variable interpolation substitutes `{<dep_name>_version}` and
     * `{<dep_name>_image_ref}` (with hyphens → underscores) wherever
     * they appear inside `build`, `runtime`, or `dockerfile` strings.
     * A successful build of THIS service additionally triggers a
     * rebuild of any service that lists it in dependsOn — that's the
     * chain-build propagation path.
     */
    dependsOn: z.array(z.string().min(1)).default([])
  })
  .superRefine((def, ctx) => {
    // dockerfile mode is mutually exclusive with the build/artifacts/
    // runtime trio: the Dockerfile already describes everything those
    // express. Allowing both would silently let one win and confuse
    // the user.
    if (def.dockerfile) {
      if (def.build || def.runtime || def.artifacts.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dockerfile"],
          message: "dockerfile: is exclusive with build/artifacts/runtime — pick one mode"
        });
      }
    }
    // Cross-field validation: every runtime.copy.from / runtime.layers
    // MUST appear in artifacts[]. Catches typos early instead of
    // producing an empty file in the runtime image.
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
      for (const l of def.runtime.layers) {
        if (!captured.has(l)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["runtime", "layers"],
            message: `runtime.layers entry "${l}" is not listed in artifacts[]`
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
export type PipelineDockerfile = z.infer<typeof pipelineDockerfileSchema>;
export type PipelineDomain = z.infer<typeof pipelineDomainSchema>;
export type PipelineLoadBalancer = z.infer<typeof pipelineLoadBalancerSchema>;
export type PipelineEnvironment = z.infer<typeof pipelineEnvironmentSchema>;
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

/**
 * Resolve the effective deployment fields for a given environment name.
 * Top-level fields are the defaults; per-env overrides win when present.
 * Returns the top-level defaults when the environment isn't in the map.
 */
export function resolveEnvironment(
  def: PipelineDefinition,
  envName: string
): {
  instances: number;
  domains: PipelineDomain[];
  loadBalancer: PipelineLoadBalancer;
  /**
   * Resolved namespace. Empty string when no kaiad.yaml-level
   * namespace was set anywhere — the agent picks a per-runtime
   * default in that case (k8s: agent's pod ns; docker: "kaiad").
   */
  namespace: string;
} {
  const env = def.environments[envName];
  return {
    instances: env?.instances ?? def.instances,
    domains: env?.domains.length ? env.domains : def.domains,
    loadBalancer: env?.loadBalancer ?? def.loadBalancer,
    namespace: env?.namespace ?? def.namespace ?? ""
  };
}

// Multi-service form: a single repo houses multiple deployable images
// (e.g. a php-fpm container plus an nginx container), each with its own
// build/runtime/ports. The MonitoredService picks one via its
// `pipelineName` field.
//
// Pipeline names follow the same k8s-style shape as environment names so
// they round-trip cleanly into image refs / labels.
const pipelineNameRegex = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Inner-pipeline schema (no `version` field — that lives at the
// multi-file root and is shared by every pipeline). All other fields
// match pipelineDefinitionSchema; we keep these in sync by hand because
// zod doesn't have a clean .pick()/.omit() story for refined schemas.
const innerPipelineSchema = z
  .object({
    build: pipelineBuildSchema.optional(),
    artifacts: z.array(safeRelativePath).default([]),
    runtime: pipelineRuntimeSchema.optional(),
    dockerfile: pipelineDockerfileSchema.optional(),
    ports: z.array(pipelinePortSchema).default([]),
    instances: z.number().int().min(0).default(1),
    domains: z.array(pipelineDomainSchema).default([]),
    loadBalancer: pipelineLoadBalancerSchema.default({ type: "none" }),
    namespace: namespaceSchema.optional(),
    environments: z.record(pipelineEnvironmentSchema).default({}),
    /** See pipelineDefinitionSchema.kind. */
    kind: z.enum(["deployable", "supporting"]).default("deployable"),
    /** See pipelineDefinitionSchema.dependsOn. */
    dependsOn: z.array(z.string().min(1)).default([])
  })
  // Same cross-field checks as the top-level pipelineDefinitionSchema.
  .superRefine((def, ctx) => {
    if (def.dockerfile) {
      if (def.build || def.runtime || def.artifacts.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dockerfile"],
          message: "dockerfile: is exclusive with build/artifacts/runtime — pick one mode"
        });
      }
    }
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
      for (const l of def.runtime.layers) {
        if (!captured.has(l)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["runtime", "layers"],
            message: `runtime.layers entry "${l}" is not listed in artifacts[]`
          });
        }
      }
    }
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
    } else if (def.domains.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ports"],
        message: "domains require at least one entry in ports[]"
      });
    }
  });

export const pipelineFileMultiSchema = z.object({
  version: z.literal(PIPELINE_VERSION),
  /** Map of pipeline name → its (version-less) inner definition. */
  services: z.record(innerPipelineSchema)
}).superRefine((file, ctx) => {
  for (const name of Object.keys(file.services)) {
    if (!pipelineNameRegex.test(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services", name],
        message: `pipeline name "${name}" must be lowercase alphanumeric with hyphens (max 63 chars)`
      });
    }
  }
  if (Object.keys(file.services).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["services"],
      message: "services map is empty — at least one pipeline is required"
    });
  }
});

export type PipelineFileMulti = z.infer<typeof pipelineFileMultiSchema>;

export type PipelineParseResult =
  | { ok: true; kind: "single"; pipeline: PipelineDefinition }
  | { ok: true; kind: "multi"; pipelines: Record<string, PipelineDefinition> }
  | { ok: false; reason: string };

function liftInner(name: string, inner: z.infer<typeof innerPipelineSchema>): PipelineDefinition {
  // Version is shared at the file root; lift it onto each inner pipeline
  // so consumers downstream get a uniform PipelineDefinition shape and
  // don't need to track the multi/single distinction.
  return { version: PIPELINE_VERSION, ...inner } as PipelineDefinition;
}

/**
 * Parse the YAML text of a kaiad.yaml file. Returns either a single-
 * pipeline result (legacy / simple repos) or a multi-pipeline result
 * (one repo, several deployable images). Detection is by presence of
 * a top-level `services:` mapping — repos that need multiple pipelines
 * write `services: { php: ..., nginx: ... }` instead of inlining
 * `build`/`runtime`/`ports` at the root.
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
  const obj = raw as Record<string, unknown>;
  if (obj.services && typeof obj.services === "object" && !Array.isArray(obj.services)) {
    const parsed = pipelineFileMultiSchema.safeParse(obj);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first.path.length > 0 ? first.path.join(".") : "<root>";
      return { ok: false, reason: `kaiad.yaml: ${path}: ${first.message}` };
    }
    const lifted: Record<string, PipelineDefinition> = {};
    for (const [name, inner] of Object.entries(parsed.data.services)) {
      lifted[name] = liftInner(name, inner);
    }
    return { ok: true, kind: "multi", pipelines: lifted };
  }
  const parsed = pipelineDefinitionSchema.safeParse(obj);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first.path.length > 0 ? first.path.join(".") : "<root>";
    return { ok: false, reason: `kaiad.yaml: ${path}: ${first.message}` };
  }
  return { ok: true, kind: "single", pipeline: parsed.data };
}

/**
 * Pick the right pipeline from a parse result, given the service's
 * configured pipelineName (or null if the service hasn't been wired
 * to a specific pipeline yet). Returns the chosen PipelineDefinition
 * or a clear error message.
 */
export function selectPipeline(
  result: PipelineParseResult,
  pipelineName: string | null | undefined
): { ok: true; pipeline: PipelineDefinition } | { ok: false; reason: string } {
  if (!result.ok) return result;
  if (result.kind === "single") {
    if (pipelineName) {
      return {
        ok: false,
        reason:
          `service has pipelineName="${pipelineName}" but kaiad.yaml is single-pipeline; ` +
          `either remove the service's pipelineName or make kaiad.yaml multi-pipeline (services: {…})`
      };
    }
    return { ok: true, pipeline: result.pipeline };
  }
  // multi
  if (!pipelineName) {
    const names = Object.keys(result.pipelines).join(", ");
    return {
      ok: false,
      reason: `kaiad.yaml is multi-pipeline (services: ${names}); set the service's pipelineName to choose one`
    };
  }
  const pipeline = result.pipelines[pipelineName];
  if (!pipeline) {
    const names = Object.keys(result.pipelines).join(", ");
    return {
      ok: false,
      reason: `kaiad.yaml does not contain pipeline "${pipelineName}" (available: ${names})`
    };
  }
  return { ok: true, pipeline };
}
