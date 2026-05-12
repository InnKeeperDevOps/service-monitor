// Postgres Large Object I/O for OCI blob bytes.
//
// Why pg_largeobject and not BYTEA?
//   - BYTEA caps at 1GB per field, and libpq reads materialize the
//     whole value into the Node heap on every `docker pull` (no
//     streaming). For 500MB layers this is a 500MB allocation per
//     pull request.
//   - pg_largeobject is keyed by an integer oid and exposes lo_open/
//     loread/lowrite/lo_close as transaction-scoped operations. We
//     read in 64K chunks and stream them straight to the HTTP response.
//
// Constraint: lo_* operations REQUIRE a transaction. Every public
// function below acquires a pool client, BEGINs a tx, runs its lo_*
// calls, COMMITs, and releases. Read streams hold the client open
// for the duration of the stream and release on end/error.

import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";

const READ_CHUNK = 64 * 1024;

const LO_READ = 0x40000; // INV_READ
const LO_WRITE = 0x20000; // INV_WRITE

// ─── Reads ──────────────────────────────────────────────────────────────

export type BlobReadOptions = {
  /** Inclusive byte range [start, end]. Open-ended end means EOF. */
  range?: { start: number; end?: number };
};

/**
 * Open a streaming read over the blob at `oid`. The returned Readable
 * holds a dedicated pool client until it ends (or errors); the caller
 * should `pipe()` it into the HTTP reply and not buffer it.
 *
 * Returns null if `oid` is missing or unreadable.
 */
export async function openBlobReadStream(
  pool: Pool,
  oid: number,
  options: BlobReadOptions = {}
): Promise<Readable | null> {
  const client = await pool.connect();
  let txStarted = false;
  let fd: number | null = null;
  try {
    await client.query("BEGIN");
    txStarted = true;
    const openRes = await client.query<{ fd: number }>(
      `SELECT lo_open($1, $2) AS fd`,
      [oid, LO_READ]
    );
    fd = openRes.rows[0]?.fd as number | undefined ?? null;
    if (fd === null) {
      throw new Error(`lo_open returned no fd for oid=${oid}`);
    }

    // Seek if a range start was requested.
    if (options.range?.start && options.range.start > 0) {
      await client.query(`SELECT lo_lseek64($1, $2, 0)`, [fd, options.range.start]);
    }

    const remaining = computeRemaining(options.range);
    const stream = makeReadStream(client, fd, remaining);
    txStarted = false; // ownership transferred to the stream
    fd = null;
    return stream;
  } catch (err) {
    try {
      if (fd !== null) await client.query(`SELECT lo_close($1)`, [fd]);
    } catch {
      /* ignore close errors during cleanup */
    }
    try {
      if (txStarted) await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    client.release();
    // Missing/invalid oid → null so the handler can 404.
    const msg = err instanceof Error ? err.message : String(err);
    if (/large object .* does not exist/i.test(msg) || /invalid large-object descriptor/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

function computeRemaining(range?: BlobReadOptions["range"]): number | null {
  if (!range) return null;
  if (range.end === undefined) return null;
  return range.end - (range.start ?? 0) + 1;
}

function makeReadStream(client: PoolClient, fd: number, remaining: number | null): Readable {
  let left = remaining;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.query(`SELECT lo_close($1)`, [fd]);
    } catch {
      /* ignore close errors */
    }
    try {
      await client.query("COMMIT");
    } catch {
      /* ignore commit errors during cleanup */
    }
    client.release();
  };

  const stream = new Readable({
    read() {
      if (closed) {
        this.push(null);
        return;
      }
      const want = left === null ? READ_CHUNK : Math.min(READ_CHUNK, left);
      if (want <= 0) {
        this.push(null);
        void cleanup();
        return;
      }
      client
        .query<{ chunk: Buffer }>(`SELECT loread($1, $2) AS chunk`, [fd, want])
        .then((res) => {
          const chunk = res.rows[0]?.chunk as Buffer | undefined;
          if (!chunk || chunk.length === 0) {
            this.push(null);
            void cleanup();
            return;
          }
          if (left !== null) left -= chunk.length;
          this.push(chunk);
        })
        .catch((err) => {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        });
    },
    destroy(err, cb) {
      void cleanup().finally(() => cb(err));
    }
  });

  return stream;
}

// ─── Writes (used by upload sessions in Phase 2) ────────────────────────

/** Allocate a new large object oid for an upload session. */
export async function createBlobOid(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ oid: number }>(`SELECT lo_create(0) AS oid`);
    const oid = Number(res.rows[0].oid);
    await client.query("COMMIT");
    return oid;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Write `chunk` at the given byte offset of the large object at `oid`.
 *
 * Uses `lo_put` (Postgres 9.4+), which is a single-statement autocommit
 * write — unlike lo_open/lowrite/lo_close it does NOT hold a pool client
 * open across the call. We don't want to hold a client for the duration
 * of a 500MB upload over a slow link; it'd starve the connection pool.
 *
 * Caller tracks the offset (typically registry_uploads.received_bytes)
 * so the OCI Content-Range can be validated against the expected next
 * position.
 */
export async function writeBlobAt(
  pool: Pool,
  oid: number,
  offset: number,
  chunk: Buffer
): Promise<void> {
  if (chunk.length === 0) return;
  await pool.query(`SELECT lo_put($1, $2, $3)`, [oid, offset, chunk]);
}

/**
 * Drain an upload body stream into the large object at `oid`, starting
 * at `startOffset`. Returns the total bytes written.
 *
 * Each iteration writes whatever the underlying socket delivers — chunk
 * granularity is determined by Node's net layer, typically 16-64K. We
 * advance the offset on the application side; lo_put handles the file-
 * level cursor.
 */
export async function streamWriteBlob(
  pool: Pool,
  oid: number,
  startOffset: number,
  stream: AsyncIterable<Buffer | Uint8Array>
): Promise<{ bytesWritten: number }> {
  let offset = startOffset;
  let bytesWritten = 0;
  for await (const piece of stream) {
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    if (buf.length === 0) continue;
    await writeBlobAt(pool, oid, offset, buf);
    offset += buf.length;
    bytesWritten += buf.length;
  }
  return { bytesWritten };
}

/** Drop a large object (used on cancelled uploads or blob deletes). */
export async function unlinkBlobOid(pool: Pool, oid: number): Promise<void> {
  await pool.query(`SELECT lo_unlink($1)`, [oid]);
}

/**
 * Stream the full content of a large object through sha256, returning
 * the digest + total size. Used at upload-commit time to verify the
 * client's `?digest=` matches what they uploaded. Reads in 64K chunks.
 */
export async function computeBlobDigest(
  pool: Pool,
  oid: number
): Promise<{ digest: string; size: number }> {
  const client = await pool.connect();
  let fd: number | null = null;
  const hash = crypto.createHash("sha256");
  let total = 0;
  try {
    await client.query("BEGIN");
    const openRes = await client.query<{ fd: number }>(
      `SELECT lo_open($1, $2) AS fd`,
      [oid, LO_READ]
    );
    fd = openRes.rows[0].fd as number;
    for (;;) {
      const res = await client.query<{ chunk: Buffer }>(
        `SELECT loread($1, $2) AS chunk`,
        [fd, READ_CHUNK]
      );
      const chunk = res.rows[0]?.chunk as Buffer | undefined;
      if (!chunk || chunk.length === 0) break;
      hash.update(chunk);
      total += chunk.length;
    }
    await client.query(`SELECT lo_close($1)`, [fd]);
    fd = null;
    await client.query("COMMIT");
    return { digest: "sha256:" + hash.digest("hex"), size: total };
  } catch (err) {
    try {
      if (fd !== null) await client.query(`SELECT lo_close($1)`, [fd]);
    } catch {
      /* ignore */
    }
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Compute the byte size of a large object. */
export async function blobOidSize(pool: Pool, oid: number): Promise<number> {
  const client = await pool.connect();
  let fd: number | null = null;
  try {
    await client.query("BEGIN");
    const openRes = await client.query<{ fd: number }>(
      `SELECT lo_open($1, $2) AS fd`,
      [oid, LO_READ]
    );
    fd = openRes.rows[0].fd as number;
    const sizeRes = await client.query<{ sz: string }>(
      `SELECT lo_lseek64($1, 0, 2) AS sz`,
      [fd]
    );
    await client.query(`SELECT lo_close($1)`, [fd]);
    fd = null;
    await client.query("COMMIT");
    return Number(sizeRes.rows[0].sz);
  } catch (err) {
    try {
      if (fd !== null) await client.query(`SELECT lo_close($1)`, [fd]);
    } catch {
      /* ignore */
    }
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
