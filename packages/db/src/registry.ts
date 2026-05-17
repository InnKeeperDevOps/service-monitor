import type { QueryFn } from "./queries.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface RegistryBlobMeta {
  digest: string;
  mediaType: string | null;
  sizeBytes: number;
  contentOid: number;
  createdAt: string;
}

export interface RegistryManifestRow {
  digest: string;
  repo: string;
  mediaType: string;
  body: Buffer;
  sizeBytes: number;
  configDigest: string | null;
  layerDigests: string[];
  referencedManifestDigests: string[];
  createdAt: string;
}

export interface RegistryTagRow {
  repo: string;
  tag: string;
  manifestDigest: string;
  updatedAt: string;
}

export interface RegistryUploadRow {
  uuid: string;
  repo: string;
  contentOid: number;
  receivedBytes: number;
  expiresAt: string;
  createdAt: string;
}

// ─── Mappers ────────────────────────────────────────────────────────────

function isoOrString(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapBlobMeta(r: Record<string, unknown>): RegistryBlobMeta {
  return {
    digest: r.digest as string,
    mediaType: r.media_type == null ? null : String(r.media_type),
    sizeBytes: Number(r.size_bytes),
    contentOid: Number(r.content_oid),
    createdAt: isoOrString(r.created_at)
  };
}

function mapManifest(r: Record<string, unknown>): RegistryManifestRow {
  return {
    digest: r.digest as string,
    repo: r.repo as string,
    mediaType: r.media_type as string,
    body: r.body as Buffer,
    sizeBytes: Number(r.size_bytes),
    configDigest: r.config_digest == null ? null : String(r.config_digest),
    layerDigests: (r.layer_digests as string[]) ?? [],
    referencedManifestDigests: (r.referenced_manifest_digests as string[]) ?? [],
    createdAt: isoOrString(r.created_at)
  };
}

function mapTag(r: Record<string, unknown>): RegistryTagRow {
  return {
    repo: r.repo as string,
    tag: r.tag as string,
    manifestDigest: r.manifest_digest as string,
    updatedAt: isoOrString(r.updated_at)
  };
}

function mapUpload(r: Record<string, unknown>): RegistryUploadRow {
  return {
    uuid: r.uuid as string,
    repo: r.repo as string,
    contentOid: Number(r.content_oid),
    receivedBytes: Number(r.received_bytes),
    expiresAt: isoOrString(r.expires_at),
    createdAt: isoOrString(r.created_at)
  };
}

// ─── Blobs ──────────────────────────────────────────────────────────────

export async function getRegistryBlobMeta(
  query: QueryFn,
  digest: string
): Promise<RegistryBlobMeta | null> {
  const { rows } = await query(
    `SELECT digest, media_type, size_bytes, content_oid, created_at
     FROM registry_blobs WHERE digest = $1`,
    [digest]
  );
  return rows.length > 0 ? mapBlobMeta(rows[0]) : null;
}

export async function deleteRegistryBlob(
  query: QueryFn,
  digest: string
): Promise<RegistryBlobMeta | null> {
  // Caller must lo_unlink(content_oid) inside the same tx.
  const { rows } = await query(
    `DELETE FROM registry_blobs WHERE digest = $1
     RETURNING digest, media_type, size_bytes, content_oid, created_at`,
    [digest]
  );
  return rows.length > 0 ? mapBlobMeta(rows[0]) : null;
}

export async function insertRegistryBlob(
  query: QueryFn,
  args: {
    digest: string;
    mediaType: string | null;
    sizeBytes: number;
    contentOid: number;
  }
): Promise<void> {
  // INSERT ... ON CONFLICT DO NOTHING — same digest = same content,
  // a duplicate upload commits idempotently.
  await query(
    `INSERT INTO registry_blobs (digest, media_type, size_bytes, content_oid)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (digest) DO NOTHING`,
    [args.digest, args.mediaType, args.sizeBytes, args.contentOid]
  );
}

// ─── Manifests ──────────────────────────────────────────────────────────

export async function getRegistryManifestByDigest(
  query: QueryFn,
  digest: string
): Promise<RegistryManifestRow | null> {
  const { rows } = await query(
    `SELECT * FROM registry_manifests WHERE digest = $1`,
    [digest]
  );
  return rows.length > 0 ? mapManifest(rows[0]) : null;
}

/**
 * Is `digest` reachable within `repo`? True when a tag in this repo
 * points at it directly, or it's a child of a manifest-list/index that
 * is tagged in this repo. Used to scope by-digest manifest pulls so a
 * globally-deduped manifest (the row's `repo` is just the first writer)
 * can't be read from a repo that never received that content — without
 * this, cross-repo/tenant manifest disclosure would be possible.
 */
export async function isManifestReachableInRepo(
  query: QueryFn,
  repo: string,
  digest: string
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1
       WHERE EXISTS (
         SELECT 1 FROM registry_tags
         WHERE repo = $1 AND manifest_digest = $2
       )
       OR EXISTS (
         SELECT 1 FROM registry_manifests parent
         JOIN registry_tags t
           ON t.manifest_digest = parent.digest AND t.repo = $1
         WHERE $2 = ANY(parent.referenced_manifest_digests)
       )`,
    [repo, digest]
  );
  return rows.length > 0;
}

export async function getRegistryManifestByTag(
  query: QueryFn,
  repo: string,
  tag: string
): Promise<RegistryManifestRow | null> {
  const { rows } = await query(
    `SELECT m.* FROM registry_manifests m
     JOIN registry_tags t ON t.manifest_digest = m.digest
     WHERE t.repo = $1 AND t.tag = $2`,
    [repo, tag]
  );
  return rows.length > 0 ? mapManifest(rows[0]) : null;
}

/**
 * Resolve a manifest for `repo` by tag or digest, applying correct
 * content-addressed repo scoping. THIS is the only function handlers
 * should use to fetch a manifest for a repo — never read or compare
 * `RegistryManifestRow.repo` (it's just the first writer; identical
 * content pushed to several repos shares one row). See the invariant
 * note on `registry_manifests` in schema.ts.
 *
 *  - by tag: the tag→manifest join is already scoped to `repo`, so a
 *    hit proves the tag belongs here regardless of who wrote the blob.
 *  - by digest: only served if the digest is reachable within `repo`
 *    (tagged here, or a child of a manifest tagged here), so a deduped
 *    digest can't be read from an unrelated repo/tenant.
 */
export async function getRegistryManifestForRepo(
  query: QueryFn,
  args: { repo: string; reference: string; isDigest: boolean }
): Promise<RegistryManifestRow | null> {
  if (!args.isDigest) {
    return getRegistryManifestByTag(query, args.repo, args.reference);
  }
  const manifest = await getRegistryManifestByDigest(query, args.reference);
  if (!manifest) return null;
  if (await isManifestReachableInRepo(query, args.repo, manifest.digest)) {
    return manifest;
  }
  return null;
}

export async function insertRegistryManifest(
  query: QueryFn,
  args: {
    digest: string;
    repo: string;
    mediaType: string;
    body: Buffer;
    configDigest: string | null;
    layerDigests: string[];
    referencedManifestDigests: string[];
  }
): Promise<void> {
  await query(
    `INSERT INTO registry_manifests
       (digest, repo, media_type, body, size_bytes, config_digest,
        layer_digests, referenced_manifest_digests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (digest) DO NOTHING`,
    [
      args.digest,
      args.repo,
      args.mediaType,
      args.body,
      args.body.length,
      args.configDigest,
      args.layerDigests,
      args.referencedManifestDigests
    ]
  );
}

export async function deleteRegistryManifest(
  query: QueryFn,
  digest: string
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM registry_manifests WHERE digest = $1 RETURNING digest`,
    [digest]
  );
  return rows.length > 0;
}

/**
 * Delete the shared manifest row ONLY if it is globally unreferenced —
 * no tag in ANY repo points at it and no manifest list references it as
 * a child. This is what makes per-repo manifest delete safe under
 * content dedup: removing repo A's tags must never destroy content repo
 * B still serves. Returns "deleted" or "kept". (When kept, GC reclaims
 * it once it actually becomes orphaned.)
 */
export async function deleteRegistryManifestIfUnreferenced(
  query: QueryFn,
  digest: string
): Promise<"deleted" | "kept"> {
  const { rows } = await query(
    `DELETE FROM registry_manifests m
      WHERE m.digest = $1
        AND NOT EXISTS (
          SELECT 1 FROM registry_tags t WHERE t.manifest_digest = $1
        )
        AND NOT EXISTS (
          SELECT 1 FROM registry_manifests parent
          WHERE $1 = ANY(parent.referenced_manifest_digests)
        )
      RETURNING digest`,
    [digest]
  );
  return rows.length > 0 ? "deleted" : "kept";
}

/** Does any tag in `repo` point directly at `digest`? */
export async function repoHasTagForManifest(
  query: QueryFn,
  repo: string,
  digest: string
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM registry_tags WHERE repo = $1 AND manifest_digest = $2 LIMIT 1`,
    [repo, digest]
  );
  return rows.length > 0;
}

// ─── Tags ───────────────────────────────────────────────────────────────

export async function upsertRegistryTag(
  query: QueryFn,
  args: { repo: string; tag: string; manifestDigest: string }
): Promise<void> {
  await query(
    `INSERT INTO registry_tags (repo, tag, manifest_digest, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (repo, tag) DO UPDATE
       SET manifest_digest = excluded.manifest_digest,
           updated_at = excluded.updated_at`,
    [args.repo, args.tag, args.manifestDigest]
  );
}

export async function deleteRegistryTag(
  query: QueryFn,
  repo: string,
  tag: string
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM registry_tags WHERE repo = $1 AND tag = $2 RETURNING tag`,
    [repo, tag]
  );
  return rows.length > 0;
}

/**
 * List tags for a repo, optionally paginated.
 *
 * Pagination follows the OCI Distribution v2 convention: `limit` is the
 * page size, `after` is the last tag returned on the previous page. The
 * server returns the next `limit` tags whose name sorts strictly after
 * `after`. Callers detect "no next page" by checking whether the page
 * has fewer than `limit` items.
 */
export async function listRegistryTagsForRepo(
  query: QueryFn,
  repo: string,
  opts: { limit?: number; after?: string } = {}
): Promise<RegistryTagRow[]> {
  const where = opts.after
    ? `WHERE repo = $1 AND tag > $2`
    : `WHERE repo = $1`;
  const params: unknown[] = opts.after ? [repo, opts.after] : [repo];
  let sql = `SELECT * FROM registry_tags ${where} ORDER BY tag ASC`;
  if (opts.limit != null) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await query(sql, params);
  return rows.map(mapTag);
}

// ─── Catalog ────────────────────────────────────────────────────────────

/**
 * List repositories alphabetically, optionally paginated.
 *
 * Pagination follows the OCI Distribution v2 convention: `limit` is the
 * page size, `after` is the last repo returned on the previous page.
 * The query returns the next `limit` repos whose name sorts strictly
 * after `after`.
 */
export async function listRegistryRepositories(
  query: QueryFn,
  opts: { limit?: number; after?: string } = {}
): Promise<string[]> {
  // Union: repos that have ever had a manifest pushed, plus repos
  // that still have a tag. (After a tag delete the manifest sticks
  // around; after a manifest delete the tag is restricted from
  // pointing at it.) DISTINCT removes the overlap.
  const params: unknown[] = [];
  let where = "";
  if (opts.after) {
    params.push(opts.after);
    where = `WHERE repo > $${params.length}`;
  }
  let sql = `SELECT repo FROM (
       SELECT DISTINCT repo FROM registry_manifests
       UNION
       SELECT DISTINCT repo FROM registry_tags
     ) r ${where}
     ORDER BY repo ASC`;
  if (opts.limit != null) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await query(sql, params);
  return rows.map((r) => r.repo as string);
}

// ─── Upload sessions ────────────────────────────────────────────────────

export async function insertRegistryUpload(
  query: QueryFn,
  args: {
    uuid: string;
    repo: string;
    contentOid: number;
    expiresAt: string;
  }
): Promise<void> {
  await query(
    `INSERT INTO registry_uploads (uuid, repo, content_oid, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [args.uuid, args.repo, args.contentOid, args.expiresAt]
  );
}

export async function getRegistryUpload(
  query: QueryFn,
  uuid: string
): Promise<RegistryUploadRow | null> {
  const { rows } = await query(
    `SELECT * FROM registry_uploads WHERE uuid = $1`,
    [uuid]
  );
  return rows.length > 0 ? mapUpload(rows[0]) : null;
}

export async function updateRegistryUploadReceived(
  query: QueryFn,
  uuid: string,
  receivedBytes: number
): Promise<void> {
  await query(
    `UPDATE registry_uploads SET received_bytes = $2 WHERE uuid = $1`,
    [uuid, receivedBytes]
  );
}

export async function deleteRegistryUpload(
  query: QueryFn,
  uuid: string
): Promise<RegistryUploadRow | null> {
  const { rows } = await query(
    `DELETE FROM registry_uploads WHERE uuid = $1
     RETURNING *`,
    [uuid]
  );
  return rows.length > 0 ? mapUpload(rows[0]) : null;
}

export async function listExpiredRegistryUploads(
  query: QueryFn,
  now: string
): Promise<RegistryUploadRow[]> {
  const { rows } = await query(
    `SELECT * FROM registry_uploads WHERE expires_at < $1`,
    [now]
  );
  return rows.map(mapUpload);
}

// ─── GC helpers ─────────────────────────────────────────────────────────

/**
 * List blobs that no manifest currently references. The result is a
 * candidate set for deletion — the GC loop unlinks their oids and
 * removes the registry_blobs row.
 */
export async function listOrphanRegistryBlobs(
  query: QueryFn
): Promise<RegistryBlobMeta[]> {
  const { rows } = await query(
    `WITH referenced AS (
       SELECT config_digest AS digest FROM registry_manifests WHERE config_digest IS NOT NULL
       UNION
       SELECT unnest(layer_digests) FROM registry_manifests
     )
     SELECT b.digest, b.media_type, b.size_bytes, b.content_oid, b.created_at
     FROM registry_blobs b
     WHERE b.digest NOT IN (SELECT digest FROM referenced)`,
    []
  );
  return rows.map(mapBlobMeta);
}

/**
 * List manifests with no tag pointing at them AND not referenced by
 * any manifest list. Candidate for deletion.
 *
 * Note: a manifest's blobs are NOT cascaded — separate blob GC runs
 * after the manifest delete is committed and the once-pinned blobs
 * become orphan.
 */
export async function listOrphanRegistryManifests(
  query: QueryFn
): Promise<{ digest: string; repo: string }[]> {
  const { rows } = await query(
    `SELECT digest, repo FROM registry_manifests m
     WHERE NOT EXISTS (
       SELECT 1 FROM registry_tags t WHERE t.manifest_digest = m.digest
     )
     AND NOT EXISTS (
       SELECT 1 FROM registry_manifests parent
       WHERE m.digest = ANY(parent.referenced_manifest_digests)
     )`,
    []
  );
  return rows.map((r) => ({ digest: r.digest as string, repo: r.repo as string }));
}

// ─── Repository visibility (public/private pull) ────────────────────────

export interface RegistryRepoVisibility {
  repo: string;
  public: boolean;
}

/** Visibility for one repo. `null` = no row (treated as private). */
export async function getRegistryRepoVisibility(
  query: QueryFn,
  repo: string
): Promise<boolean | null> {
  const { rows } = await query(
    `SELECT public FROM registry_repository_visibility WHERE repo = $1`,
    [repo]
  );
  if (rows.length === 0) return null;
  return rows[0].public === true;
}

/** Upsert a repo's visibility. */
export async function setRegistryRepoVisibility(
  query: QueryFn,
  repo: string,
  isPublic: boolean
): Promise<void> {
  await query(
    `INSERT INTO registry_repository_visibility (repo, public, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (repo) DO UPDATE
       SET public = excluded.public,
           updated_at = excluded.updated_at`,
    [repo, isPublic]
  );
}

/** All explicitly-set visibility rows. */
export async function listRegistryRepoVisibility(
  query: QueryFn
): Promise<RegistryRepoVisibility[]> {
  const { rows } = await query(
    `SELECT repo, public FROM registry_repository_visibility`,
    []
  );
  return rows.map((r) => ({ repo: r.repo as string, public: r.public === true }));
}
