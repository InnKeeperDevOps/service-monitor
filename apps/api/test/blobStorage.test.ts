import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  createBlobOid,
  writeBlobAt,
  streamWriteBlob,
  unlinkBlobOid,
  computeBlobDigest,
  blobOidSize,
  openBlobReadStream
} from "../src/registry/blobStorage.js";

// In-memory pg large-object simulation. lo_* are transaction-scoped;
// the fake client routes the exact SQL blobStorage.ts issues.
function makeFakePool() {
  const los = new Map<number, Buffer>();
  let nextOid = 1000;
  let nextFd = 1;
  const fds = new Map<number, { oid: number; pos: number }>();

  function clientQuery(sql: string, params: unknown[] = []) {
    const s = String(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s.trim())) return { rows: [] };
    if (/lo_create/i.test(s)) {
      const oid = nextOid++;
      los.set(oid, Buffer.alloc(0));
      return { rows: [{ oid }] };
    }
    if (/lo_open/i.test(s)) {
      const oid = params[0] as number;
      if (!los.has(oid)) throw new Error(`large object ${oid} does not exist`);
      const fd = nextFd++;
      fds.set(fd, { oid, pos: 0 });
      return { rows: [{ fd }] };
    }
    if (/lo_lseek64/i.test(s) && /AS sz/i.test(s)) {
      const st = fds.get(params[0] as number)!;
      return { rows: [{ sz: String((los.get(st.oid) ?? Buffer.alloc(0)).length) }] };
    }
    if (/lo_lseek64/i.test(s)) {
      const st = fds.get(params[0] as number)!;
      st.pos = params[1] as number;
      return { rows: [{}] };
    }
    if (/loread/i.test(s)) {
      const st = fds.get(params[0] as number)!;
      const want = params[1] as number;
      const buf = los.get(st.oid) ?? Buffer.alloc(0);
      const chunk = buf.subarray(st.pos, st.pos + want);
      st.pos += chunk.length;
      return { rows: [{ chunk: Buffer.from(chunk) }] };
    }
    if (/lo_close/i.test(s)) {
      fds.delete(params[0] as number);
      return { rows: [] };
    }
    if (/lo_put/i.test(s)) {
      const [oid, offset, data] = params as [number, number, Buffer];
      const cur = los.get(oid) ?? Buffer.alloc(0);
      const end = offset + data.length;
      const next = Buffer.alloc(Math.max(cur.length, end));
      cur.copy(next);
      data.copy(next, offset);
      los.set(oid, next);
      return { rows: [] };
    }
    if (/lo_unlink/i.test(s)) {
      los.delete(params[0] as number);
      return { rows: [] };
    }
    return { rows: [] };
  }

  const client = {
    query: async (sql: string, params: unknown[] = []) => clientQuery(sql, params),
    release() {}
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string, params: unknown[] = []) => clientQuery(sql, params)
  };
  return { pool: pool as never, los };
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}

describe("blobStorage: writes", () => {
  it("createBlobOid allocates, writeBlobAt + streamWriteBlob persist bytes", async () => {
    const { pool, los } = makeFakePool();
    const oid = await createBlobOid(pool);
    expect(los.has(oid)).toBe(true);

    await writeBlobAt(pool, oid, 0, Buffer.from("hello "));
    await writeBlobAt(pool, oid, 6, Buffer.alloc(0)); // no-op early return
    const gen = (async function* () {
      yield Buffer.from("brave ");
      yield new Uint8Array(); // skipped (length 0)
      yield Buffer.from("world");
    })();
    const { bytesWritten } = await streamWriteBlob(pool, oid, 6, gen);
    expect(bytesWritten).toBe(11);
    expect(los.get(oid)!.toString()).toBe("hello brave world");
  });

  it("blobOidSize + computeBlobDigest match the content", async () => {
    const { pool } = makeFakePool();
    const oid = await createBlobOid(pool);
    const payload = Buffer.from("x".repeat(100_000)); // > one 64K read
    await writeBlobAt(pool, oid, 0, payload);

    expect(await blobOidSize(pool, oid)).toBe(payload.length);
    const { digest, size } = await computeBlobDigest(pool, oid);
    expect(size).toBe(payload.length);
    expect(digest).toBe(
      "sha256:" + crypto.createHash("sha256").update(payload).digest("hex")
    );
  });

  it("unlinkBlobOid drops the object", async () => {
    const { pool, los } = makeFakePool();
    const oid = await createBlobOid(pool);
    await unlinkBlobOid(pool, oid);
    expect(los.has(oid)).toBe(false);
  });
});

describe("blobStorage: read streams", () => {
  it("streams the full object", async () => {
    const { pool } = makeFakePool();
    const oid = await createBlobOid(pool);
    const data = Buffer.from("a".repeat(70_000) + "TAIL");
    await writeBlobAt(pool, oid, 0, data);

    const stream = await openBlobReadStream(pool, oid);
    expect(stream).not.toBeNull();
    expect((await collect(stream!)).equals(data)).toBe(true);
  });

  it("honours a [start,end] byte range", async () => {
    const { pool } = makeFakePool();
    const oid = await createBlobOid(pool);
    await writeBlobAt(pool, oid, 0, Buffer.from("0123456789"));

    const stream = await openBlobReadStream(pool, oid, { range: { start: 2, end: 5 } });
    expect((await collect(stream!)).toString()).toBe("2345");
  });

  it("returns null for a missing oid", async () => {
    const { pool } = makeFakePool();
    expect(await openBlobReadStream(pool, 999_999)).toBeNull();
  });

  it("destroy() cleans up without throwing", async () => {
    const { pool } = makeFakePool();
    const oid = await createBlobOid(pool);
    await writeBlobAt(pool, oid, 0, Buffer.from("data"));
    const stream = await openBlobReadStream(pool, oid);
    await new Promise<void>((resolve) => {
      stream!.destroy();
      stream!.on("close", resolve);
    });
    expect(stream!.destroyed).toBe(true);
  });
});
