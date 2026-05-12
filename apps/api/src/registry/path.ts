// Parses OCI Distribution v2 URL paths into structured operations.
//
// Fastify can't route segments with literal slashes in a single :param,
// and OCI repo names are slash-allowed (e.g. `library/alpine/sub`). So
// every /v2/* request lands on one wildcard route and dispatches here.
//
// Spec reference: https://github.com/opencontainers/distribution-spec/blob/main/spec.md
// The naming grammar for <name> is:
//   name      ::= component ('/' component)*
//   component ::= alpha-numeric ('.' | '_' | '__' | '-' alpha-numeric+)*
// We don't strictly enforce that here — we trust the URL and let invalid
// digests/refs fail downstream when the DB lookup misses.

export type RegistryOp =
  | { kind: "ping" }
  | { kind: "catalog" }
  | { kind: "tagsList"; repo: string }
  | { kind: "manifest"; repo: string; reference: string }
  | { kind: "blob"; repo: string; digest: string }
  | { kind: "uploadInit"; repo: string }
  | { kind: "uploadSession"; repo: string; uuid: string };

export type ParseResult =
  | { ok: true; op: RegistryOp }
  | { ok: false; reason: string };

/**
 * Parse a `/v2/...` path. `pathAfterV2` is the URL after the `/v2/` prefix,
 * with no leading slash and no query string.
 *
 * Examples:
 *   "" → ping
 *   "_catalog" → catalog
 *   "library/alpine/tags/list" → tagsList(repo="library/alpine")
 *   "kaiad-agent/manifests/latest" → manifest(repo, reference="latest")
 *   "kaiad-agent/blobs/sha256:abc..." → blob(repo, digest)
 *   "kaiad-agent/blobs/uploads/" → uploadInit(repo)
 *   "kaiad-agent/blobs/uploads/<uuid>" → uploadSession(repo, uuid)
 */
export function parseRegistryPath(pathAfterV2: string): ParseResult {
  // Strip a trailing slash for everything except uploads/ (which is the
  // distinguishing marker for upload-init). We need to inspect the raw
  // suffix to make that call.
  if (pathAfterV2 === "" || pathAfterV2 === "/") {
    return { ok: true, op: { kind: "ping" } };
  }
  if (pathAfterV2 === "_catalog") {
    return { ok: true, op: { kind: "catalog" } };
  }

  // Find the last occurrence of "/tags/list", "/manifests/...", "/blobs/...".
  // The repo name is everything before that marker. We scan for the
  // marker rather than splitting on "/" because the repo itself contains
  // slashes.

  const tagsMatch = pathAfterV2.match(/^(.+)\/tags\/list$/);
  if (tagsMatch) {
    return { ok: true, op: { kind: "tagsList", repo: tagsMatch[1] } };
  }

  const manifestMatch = pathAfterV2.match(/^(.+)\/manifests\/(.+)$/);
  if (manifestMatch) {
    // The reference is either a digest ("sha256:abc...") or a tag.
    return {
      ok: true,
      op: { kind: "manifest", repo: manifestMatch[1], reference: manifestMatch[2] }
    };
  }

  // Blobs: distinguish upload subpaths from blob-by-digest.
  // /v2/<name>/blobs/uploads/        → upload init
  // /v2/<name>/blobs/uploads/<uuid>  → upload session ops
  // /v2/<name>/blobs/<digest>        → blob by digest
  const uploadInitMatch = pathAfterV2.match(/^(.+)\/blobs\/uploads\/?$/);
  if (uploadInitMatch) {
    return { ok: true, op: { kind: "uploadInit", repo: uploadInitMatch[1] } };
  }
  const uploadSessionMatch = pathAfterV2.match(/^(.+)\/blobs\/uploads\/([^/]+)$/);
  if (uploadSessionMatch) {
    return {
      ok: true,
      op: { kind: "uploadSession", repo: uploadSessionMatch[1], uuid: uploadSessionMatch[2] }
    };
  }
  const blobMatch = pathAfterV2.match(/^(.+)\/blobs\/(.+)$/);
  if (blobMatch) {
    return { ok: true, op: { kind: "blob", repo: blobMatch[1], digest: blobMatch[2] } };
  }

  return { ok: false, reason: `Unknown /v2 path: ${pathAfterV2}` };
}

/** A sha256 digest matches `sha256:<64 hex chars>`. */
export function isValidDigest(digest: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(digest);
}
