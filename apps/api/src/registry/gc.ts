// Registry garbage collection.
//
// Three kinds of reclamation, run in order:
//
//   1. Expired upload sessions — registry_uploads rows whose expires_at
//      is in the past. Their content_oid (the partially-written blob)
//      gets unlinked, then the row is deleted. Without this, a client
//      that crashed mid-push leaves a dangling oid forever.
//
//   2. Orphan manifests — registry_manifests rows that no tag points
//      at AND no other manifest references (via manifest-list). The
//      DB row goes; the blobs it referenced become candidates for the
//      next step.
//
//   3. Orphan blobs — registry_blobs rows whose digest is not in
//      any manifest's config_digest or layer_digests. Row + oid.
//
// Run order matters: deleting manifests first lets blob GC pick up the
// newly-orphaned blobs in the same sweep.
//
// Idempotent and safe to run while the registry is serving traffic —
// every step uses single-row deletes (no global locks). A push that
// races with GC at worst sees a 404 on a blob it expected, and crane's
// retry will succeed on the next attempt.

import type { Pool } from "pg";
import {
  deleteRegistryManifest,
  deleteRegistryUpload,
  listExpiredRegistryUploads,
  listOrphanRegistryBlobs,
  listOrphanRegistryManifests,
  type QueryFn
} from "@sm/db";
import { unlinkBlobOid } from "./blobStorage.js";

export type GcStats = {
  expiredUploadsReclaimed: number;
  orphanManifestsReclaimed: number;
  orphanBlobsReclaimed: number;
  bytesReclaimed: number;
  errors: string[];
};

export type GcOptions = {
  /**
   * Test seam for the "now" timestamp used in expired-uploads queries.
   * Production callers omit this and we use Date.now().
   */
  nowMs?: number;
  /** Optional progress callback — receives one line per step. */
  log?: (line: string) => void;
};

export async function runGarbageCollection(
  pool: Pool,
  queryFn: QueryFn,
  options: GcOptions = {}
): Promise<GcStats> {
  const stats: GcStats = {
    expiredUploadsReclaimed: 0,
    orphanManifestsReclaimed: 0,
    orphanBlobsReclaimed: 0,
    bytesReclaimed: 0,
    errors: []
  };
  const log = options.log ?? (() => undefined);
  const now = new Date(options.nowMs ?? Date.now()).toISOString();

  // 1. Expired upload sessions.
  log(`[gc] scanning expired uploads (now=${now})`);
  const expired = await listExpiredRegistryUploads(queryFn, now);
  for (const upload of expired) {
    try {
      await unlinkBlobOid(pool, upload.contentOid);
      await deleteRegistryUpload(queryFn, upload.uuid);
      stats.expiredUploadsReclaimed++;
    } catch (err) {
      stats.errors.push(`upload ${upload.uuid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`[gc] reclaimed ${stats.expiredUploadsReclaimed} expired upload(s)`);

  // 2. Orphan manifests.
  log(`[gc] scanning orphan manifests`);
  const orphanManifests = await listOrphanRegistryManifests(queryFn);
  for (const m of orphanManifests) {
    try {
      const deleted = await deleteRegistryManifest(queryFn, m.digest);
      if (deleted) stats.orphanManifestsReclaimed++;
    } catch (err) {
      stats.errors.push(`manifest ${m.digest}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`[gc] reclaimed ${stats.orphanManifestsReclaimed} orphan manifest(s)`);

  // 3. Orphan blobs.
  log(`[gc] scanning orphan blobs`);
  const orphanBlobs = await listOrphanRegistryBlobs(queryFn);
  for (const blob of orphanBlobs) {
    try {
      // Order: lo_unlink first (frees the bytes), then DELETE the row.
      // If the lo_unlink succeeds but the DELETE doesn't, the next GC
      // pass sees a row whose oid is already gone — we accept the
      // small inconsistency window because the alternative (DELETE
      // first, then lo_unlink) loses track of the oid on partial
      // failure and leaves an actual leak.
      await unlinkBlobOid(pool, blob.contentOid);
      await queryFn(`DELETE FROM registry_blobs WHERE digest = $1`, [blob.digest]);
      stats.orphanBlobsReclaimed++;
      stats.bytesReclaimed += blob.sizeBytes;
    } catch (err) {
      stats.errors.push(`blob ${blob.digest}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`[gc] reclaimed ${stats.orphanBlobsReclaimed} orphan blob(s), ${stats.bytesReclaimed} bytes`);

  return stats;
}
