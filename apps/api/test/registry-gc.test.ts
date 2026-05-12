// GC orchestrator tests. Drives runGarbageCollection() against an
// in-memory pool that simulates the registry_* tables and lo_unlink.

import { describe, it, expect, vi } from "vitest";
import type { QueryFn } from "@sm/db";
import { runGarbageCollection } from "../src/registry/gc.js";

interface FakeState {
  blobs: Map<number, Buffer>;
  blobRows: Map<string, { sizeBytes: number; contentOid: number }>;
  manifests: Map<
    string,
    { configDigest: string | null; layerDigests: string[]; refs: string[] }
  >;
  tags: Set<string>; // repo|tag → manifestDigest is the value half, key is repo|tag
  tagToDigest: Map<string, string>;
  uploads: Map<string, { contentOid: number; expiresAt: string }>;
}

function newState(): FakeState {
  return {
    blobs: new Map(),
    blobRows: new Map(),
    manifests: new Map(),
    tags: new Set(),
    tagToDigest: new Map(),
    uploads: new Map()
  };
}

function makePool(state: FakeState): any {
  const exec = async (sql: string, params: any[] = []) => {
    const s = sql.trim();
    if (/SELECT lo_unlink/i.test(s)) {
      state.blobs.delete(Number(params[0]));
      return { rows: [{ lo_unlink: 1 }] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
    return { rows: [] };
  };
  return {
    query: vi.fn(exec),
    connect: vi.fn(async () => ({ query: vi.fn(exec), release: vi.fn() }))
  };
}

function makeQueryFn(state: FakeState): QueryFn {
  return async (sql: string, params: unknown[] = []) => {
    const s = sql.trim();
    // Expired uploads: SELECT * FROM registry_uploads WHERE expires_at < $1
    if (/FROM registry_uploads WHERE expires_at/i.test(s)) {
      const now = String(params[0]);
      const rows: any[] = [];
      for (const [uuid, u] of state.uploads.entries()) {
        if (u.expiresAt < now) {
          rows.push({
            uuid,
            repo: "r",
            content_oid: u.contentOid,
            received_bytes: 0,
            expires_at: u.expiresAt,
            created_at: new Date()
          });
        }
      }
      return { rows };
    }
    // Delete upload + return row
    if (/DELETE FROM registry_uploads/i.test(s)) {
      const uuid = String(params[0]);
      const u = state.uploads.get(uuid);
      if (!u) return { rows: [] };
      state.uploads.delete(uuid);
      return {
        rows: [
          {
            uuid,
            repo: "r",
            content_oid: u.contentOid,
            received_bytes: 0,
            expires_at: u.expiresAt,
            created_at: new Date()
          }
        ]
      };
    }
    // Orphan manifests
    if (/SELECT digest, repo FROM registry_manifests m/i.test(s)) {
      const rows: any[] = [];
      const tagDigests = new Set(state.tagToDigest.values());
      const refs = new Set<string>();
      for (const m of state.manifests.values()) {
        for (const r of m.refs) refs.add(r);
      }
      for (const [digest, m] of state.manifests.entries()) {
        if (!tagDigests.has(digest) && !refs.has(digest)) {
          rows.push({ digest, repo: "r" });
        }
      }
      return { rows };
    }
    if (/DELETE FROM registry_manifests/i.test(s)) {
      const digest = String(params[0]);
      if (!state.manifests.has(digest)) return { rows: [] };
      state.manifests.delete(digest);
      return { rows: [{ digest }] };
    }
    // Orphan blobs
    if (/WITH referenced AS/i.test(s)) {
      const referenced = new Set<string>();
      for (const m of state.manifests.values()) {
        if (m.configDigest) referenced.add(m.configDigest);
        for (const l of m.layerDigests) referenced.add(l);
      }
      const rows: any[] = [];
      for (const [digest, b] of state.blobRows.entries()) {
        if (!referenced.has(digest)) {
          rows.push({
            digest,
            media_type: null,
            size_bytes: b.sizeBytes,
            content_oid: b.contentOid,
            created_at: new Date()
          });
        }
      }
      return { rows };
    }
    if (/DELETE FROM registry_blobs/i.test(s)) {
      const digest = String(params[0]);
      state.blobRows.delete(digest);
      return { rows: [] };
    }
    return { rows: [] };
  };
}

describe("runGarbageCollection", () => {
  it("reclaims expired upload sessions and unlinks their oids", async () => {
    const state = newState();
    state.blobs.set(1, Buffer.from("partial"));
    state.uploads.set("u1", { contentOid: 1, expiresAt: "2020-01-01T00:00:00Z" });
    state.uploads.set("u2", { contentOid: 2, expiresAt: "2099-01-01T00:00:00Z" });

    const stats = await runGarbageCollection(makePool(state), makeQueryFn(state), {
      nowMs: Date.parse("2026-05-01T00:00:00Z")
    });
    expect(stats.expiredUploadsReclaimed).toBe(1);
    expect(state.uploads.has("u1")).toBe(false);
    expect(state.uploads.has("u2")).toBe(true);
    expect(state.blobs.has(1)).toBe(false);
  });

  it("reclaims orphan manifests not referenced by tags or parents", async () => {
    const state = newState();
    state.manifests.set("sha256:m1", { configDigest: null, layerDigests: [], refs: [] });
    state.manifests.set("sha256:m2", { configDigest: null, layerDigests: [], refs: [] });
    // m1 is tagged, m2 is orphan.
    state.tagToDigest.set("r|latest", "sha256:m1");

    const stats = await runGarbageCollection(makePool(state), makeQueryFn(state));
    expect(stats.orphanManifestsReclaimed).toBe(1);
    expect(state.manifests.has("sha256:m1")).toBe(true);
    expect(state.manifests.has("sha256:m2")).toBe(false);
  });

  it("reclaims orphan blobs and tallies bytes reclaimed", async () => {
    const state = newState();
    state.blobs.set(7, Buffer.from("x".repeat(500)));
    state.blobRows.set("sha256:keep", { sizeBytes: 100, contentOid: 6 });
    state.blobRows.set("sha256:orphan", { sizeBytes: 500, contentOid: 7 });
    // A manifest references "keep" but not "orphan".
    state.manifests.set("sha256:m", {
      configDigest: "sha256:keep",
      layerDigests: [],
      refs: []
    });
    state.tagToDigest.set("r|latest", "sha256:m");

    const stats = await runGarbageCollection(makePool(state), makeQueryFn(state));
    expect(stats.orphanBlobsReclaimed).toBe(1);
    expect(stats.bytesReclaimed).toBe(500);
    expect(state.blobRows.has("sha256:keep")).toBe(true);
    expect(state.blobRows.has("sha256:orphan")).toBe(false);
    expect(state.blobs.has(7)).toBe(false);
  });

  it("manifest GC unblocks blob GC in the same pass", async () => {
    // m1 is orphan; it references blob "b1". After manifest GC,
    // b1 should become orphan and get reclaimed by the same call.
    const state = newState();
    state.blobs.set(11, Buffer.from("layer-bytes"));
    state.blobRows.set("sha256:b1", { sizeBytes: 11, contentOid: 11 });
    state.manifests.set("sha256:m1", {
      configDigest: "sha256:b1",
      layerDigests: [],
      refs: []
    });
    // No tag points at m1 → m1 is orphan.

    const stats = await runGarbageCollection(makePool(state), makeQueryFn(state));
    expect(stats.orphanManifestsReclaimed).toBe(1);
    expect(stats.orphanBlobsReclaimed).toBe(1);
    expect(stats.bytesReclaimed).toBe(11);
    expect(state.manifests.size).toBe(0);
    expect(state.blobRows.size).toBe(0);
  });

  it("reports errors without aborting the sweep", async () => {
    const state = newState();
    state.blobs.set(1, Buffer.from("x"));
    state.uploads.set("u1", { contentOid: 1, expiresAt: "2020-01-01T00:00:00Z" });
    state.manifests.set("sha256:m", { configDigest: null, layerDigests: [], refs: [] });

    const queryFn = makeQueryFn(state);
    // Wrap the queryFn so the manifest delete throws once.
    let manifestDeleteCalls = 0;
    const wrapped: QueryFn = async (sql, params) => {
      if (/DELETE FROM registry_manifests/i.test(sql) && manifestDeleteCalls === 0) {
        manifestDeleteCalls++;
        throw new Error("simulated failure");
      }
      return queryFn(sql, params);
    };

    const stats = await runGarbageCollection(makePool(state), wrapped);
    // Upload still cleaned (different phase), error recorded.
    expect(stats.expiredUploadsReclaimed).toBe(1);
    expect(stats.errors.length).toBe(1);
    expect(stats.errors[0]).toContain("simulated failure");
  });
});
