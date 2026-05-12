// DB-backed registry admin helpers. Replaces the registry:2 HTTP proxy
// in apps/api/src/registryAdmin.ts after the Phase-3 cutover.
//
// The panel's Registry page calls /api/v1/registry/* and expects rich
// per-tag info (tag, manifest digest, size, createdAt). With the native
// server we have all of that in Postgres, so the panel-facing routes
// can read directly without HTTP round-trips.

import type { Pool } from "pg";
import {
  getRegistryBlobMeta,
  getRegistryManifestByDigest,
  listRegistryRepositories as dbListRepos,
  listRegistryTagsForRepo,
  type QueryFn
} from "@sm/db";
import { openBlobReadStream } from "./blobStorage.js";

export type RegistryRepository = { name: string };

export type RegistryTag = {
  tag: string;
  /** sha256:… for the manifest reference. Always set in this codepath. */
  digest?: string;
  /** Total bytes (config + layers) when computable. Undefined for manifest lists. */
  sizeBytes?: number;
  /** Creation time pulled from image config, if present. */
  createdAt?: string;
};

export async function listRepositories(queryFn: QueryFn): Promise<RegistryRepository[]> {
  const names = await dbListRepos(queryFn);
  return names.map((name) => ({ name }));
}

export async function listTags(
  pool: Pool,
  queryFn: QueryFn,
  repo: string
): Promise<RegistryTag[]> {
  const tagRows = await listRegistryTagsForRepo(queryFn, repo);
  const out: RegistryTag[] = [];
  for (const t of tagRows) {
    out.push(await describeTag(pool, queryFn, repo, t.tag, t.manifestDigest));
  }
  return out;
}

async function describeTag(
  pool: Pool,
  queryFn: QueryFn,
  repo: string,
  tag: string,
  manifestDigest: string
): Promise<RegistryTag> {
  const manifest = await getRegistryManifestByDigest(queryFn, manifestDigest);
  if (!manifest || manifest.repo !== repo) {
    // Tag points at a digest whose manifest got reaped — shouldn't
    // happen because the FK is RESTRICT, but defensive.
    return { tag, digest: manifestDigest };
  }

  // Manifest list / image index: no layer sizes available without
  // recursing into the per-platform manifests. Match the previous
  // proxy's behaviour and skip size for these.
  if (
    manifest.mediaType === "application/vnd.docker.distribution.manifest.list.v2+json" ||
    manifest.mediaType === "application/vnd.oci.image.index.v1+json"
  ) {
    return { tag, digest: manifestDigest };
  }

  // Sum config + layer blob sizes via a single batched query.
  const blobDigests = [
    ...(manifest.configDigest ? [manifest.configDigest] : []),
    ...manifest.layerDigests
  ];
  let sizeBytes: number | undefined;
  if (blobDigests.length > 0) {
    const { rows } = await queryFn(
      `SELECT digest, size_bytes FROM registry_blobs WHERE digest = ANY($1::text[])`,
      [blobDigests]
    );
    sizeBytes = rows.reduce((acc, r) => acc + Number(r.size_bytes), 0);
  }

  // Created date from the image config blob's "created" field. We
  // stream the blob bytes (small — typically <2KB) and parse as JSON.
  // Failures (config missing, bad JSON, no `created`) leave createdAt
  // undefined.
  let createdAt: string | undefined;
  if (manifest.configDigest) {
    try {
      const cfgMeta = await getRegistryBlobMeta(queryFn, manifest.configDigest);
      if (cfgMeta) {
        const stream = await openBlobReadStream(pool, cfgMeta.contentOid);
        if (stream) {
          const chunks: Buffer[] = [];
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            created?: string;
          };
          createdAt = body.created;
        }
      }
    } catch {
      /* leave createdAt undefined */
    }
  }

  return { tag, digest: manifestDigest, sizeBytes, createdAt };
}

/**
 * Delete a tag (and its manifest if no other tag points at it). Returns
 * the deleted manifest digest, or null if the tag doesn't exist.
 *
 * Cascading semantics:
 *   1. Look up the tag → manifest_digest.
 *   2. Remove the tag.
 *   3. If no other tag in any repo points at this digest, also delete
 *      the manifest (and let GC reap orphaned blob oids in Phase 4).
 *      Otherwise leave the manifest in place — other tags still need it.
 */
export async function deleteTag(
  queryFn: QueryFn,
  repo: string,
  tag: string
): Promise<{ deleted: boolean; digest?: string }> {
  const tagRows = await listRegistryTagsForRepo(queryFn, repo);
  const target = tagRows.find((t) => t.tag === tag);
  if (!target) return { deleted: false };

  await queryFn(
    `DELETE FROM registry_tags WHERE repo = $1 AND tag = $2`,
    [repo, tag]
  );

  // Drop the manifest only if no remaining tag (in any repo) references it.
  const { rows } = await queryFn(
    `SELECT 1 FROM registry_tags WHERE manifest_digest = $1 LIMIT 1`,
    [target.manifestDigest]
  );
  if (rows.length === 0) {
    await queryFn(
      `DELETE FROM registry_manifests WHERE digest = $1`,
      [target.manifestDigest]
    );
  }

  return { deleted: true, digest: target.manifestDigest };
}
