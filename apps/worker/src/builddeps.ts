// Build-time dependency resolution + variable interpolation.
//
// Services may declare `dependsOn: [<other-service-name>]` in their
// kaiad.yaml. Before the build runs we:
//   1. Look up each dep's latest successful build (by tenant + name).
//   2. Compute a set of substitution variables:
//        {<dep>_version}     → short git SHA (12 chars)
//        {<dep>_image_ref}   → full image reference incl. tag
//        {<dep>_build_id}    → UUID of the dep build
//        {<dep>_git_sha}     → full git SHA
//      where `<dep>` is the dep service name with hyphens swapped to
//      underscores so the brace template is a valid identifier.
//   3. Walk every string field in the resolved pipeline (build.image,
//      build.steps, runtime.image, runtime.command, runtime.layers,
//      dockerfile.image, dockerfile.args, etc.) and substitute the
//      variables in-place.
//
// Also exposes system-wide variables (no dep prefix) so kaiad.yaml can
// avoid hard-coding the registry hostname:
//   {kaiad_registry_host}     → external registry host (KAIAD_REGISTRY_HOST)
//   {kaiad_registry_internal} → loopback host the worker uses for pushes
//
// Errors are surfaced as a `BuildDepsError` carrying both a
// human-readable reason and the failed dep name, so the caller can
// fail the build with an actionable log line.
import type { PipelineDefinition } from "@sm/contracts";
import {
  getLatestSuccessfulBuildByServiceName,
  type QueryFn
} from "@sm/db";

export class BuildDepsError extends Error {
  constructor(
    message: string,
    /** The dep service name that triggered the failure, or null when generic. */
    public depName: string | null
  ) {
    super(message);
    this.name = "BuildDepsError";
  }
}

/** Sanitise a service name for use as a template-variable identifier. */
function varKey(serviceName: string): string {
  return serviceName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Resolve every dep listed in `pipeline.dependsOn` to its latest
 * successful build's vars. Returns the variable map plus the list of
 * resolved (dep → build) pairs so the caller can log them.
 *
 * Throws BuildDepsError when a dep has no successful build yet; the
 * caller is expected to fail the build with that reason.
 */
export async function resolveDeps(
  query: QueryFn,
  tenantId: string,
  pipeline: PipelineDefinition,
  options: { registryHost?: string; registryInternal?: string } = {}
): Promise<{
  vars: Record<string, string>;
  resolved: Array<{
    depName: string;
    buildId: string;
    gitSha: string;
    imageRef: string | null;
  }>;
}> {
  const vars: Record<string, string> = {};
  // System-wide vars first — kaiad.yaml can use these even when there
  // are no dependsOn entries.
  if (options.registryHost) vars.kaiad_registry_host = options.registryHost;
  if (options.registryInternal) vars.kaiad_registry_internal = options.registryInternal;
  const resolved: Array<{
    depName: string;
    buildId: string;
    gitSha: string;
    imageRef: string | null;
  }> = [];

  for (const depName of pipeline.dependsOn) {
    const dep = await getLatestSuccessfulBuildByServiceName(query, tenantId, depName);
    if (!dep) {
      throw new BuildDepsError(
        `dependency "${depName}" has no successful build yet — trigger or wait for its build first`,
        depName
      );
    }
    const key = varKey(depName);
    // _version is the FULL git SHA — that's what the build pipeline
    // actually pushes as the image tag, so `panel.dev/foo:{foo_version}`
    // resolves to a tag that exists in the registry. _short_version
    // is the 12-char form for display in non-tag contexts.
    vars[`${key}_version`] = dep.gitSha;
    vars[`${key}_short_version`] = dep.gitSha.length > 12 ? dep.gitSha.slice(0, 12) : dep.gitSha;
    vars[`${key}_git_sha`] = dep.gitSha;
    vars[`${key}_build_id`] = dep.buildId;
    if (dep.imageRef) {
      vars[`${key}_image_ref`] = dep.imageRef;
      // The `_image` alias matches the user-facing example
      // `panel.dev.kaiad.dev/foo:{foo_image_version}` where the
      // bare image stem (no tag) is also handy.
      const colonIdx = dep.imageRef.lastIndexOf(":");
      vars[`${key}_image`] = colonIdx >= 0 ? dep.imageRef.slice(0, colonIdx) : dep.imageRef;
    }
    resolved.push({ depName, buildId: dep.buildId, gitSha: dep.gitSha, imageRef: dep.imageRef });
  }

  return { vars, resolved };
}

/**
 * Substitute `{var_name}` occurrences in `s` using `vars`. Unknown
 * variables are left intact (with a sentinel suffix in the returned
 * `missing` set) so the build log can flag templating typos without
 * silently shipping a broken image ref.
 */
export function substituteString(s: string, vars: Record<string, string>): {
  out: string;
  missing: string[];
} {
  const missing = new Set<string>();
  const out = s.replace(/\{([a-z0-9_]+)\}/gi, (full, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      missing.add(name);
      return full;
    }
    return v;
  });
  return { out, missing: [...missing] };
}

/**
 * Walk the pipeline structure and substitute variables in every
 * string. Returns a NEW pipeline (the input is treated as immutable
 * for safety) plus the set of unresolved variables collected across
 * the entire pipeline — the caller fails the build when this is
 * non-empty.
 *
 * We don't try to be selective about which fields can interpolate:
 * any string in the pipeline schema can contain `{var}` and it gets
 * substituted. That's simpler than maintaining an allowlist + matches
 * what users will expect.
 */
export function substitutePipeline(
  pipeline: PipelineDefinition,
  vars: Record<string, string>
): { pipeline: PipelineDefinition; missing: string[] } {
  const missing = new Set<string>();
  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const r = substituteString(v, vars);
      for (const m of r.missing) missing.add(m);
      return r.out;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }
  // Deep clone via walk + JSON would lose Date/Buffer; pipeline is
  // a pure JSON-ish shape from zod so the walk's reconstruction is
  // sound.
  const out = walk(pipeline) as PipelineDefinition;
  return { pipeline: out, missing: [...missing] };
}
