import { describe, it, expect, vi } from "vitest";
import {
  deleteRegistryBlob,
  deleteRegistryManifest,
  deleteRegistryTag,
  deleteRegistryUpload,
  getRegistryBlobMeta,
  getRegistryManifestByDigest,
  getRegistryManifestByTag,
  getRegistryUpload,
  insertRegistryBlob,
  insertRegistryManifest,
  insertRegistryUpload,
  listExpiredRegistryUploads,
  listOrphanRegistryBlobs,
  listOrphanRegistryManifests,
  listRegistryRepositories,
  listRegistryTagsForRepo,
  updateRegistryUploadReceived,
  upsertRegistryTag,
  type QueryFn
} from "../src/index.js";

function mockQuery(rows: Record<string, unknown>[] = []): QueryFn {
  return vi.fn().mockResolvedValue({ rows });
}

describe("registry: blob queries", () => {
  it("getRegistryBlobMeta maps row → camelCase", async () => {
    const query = mockQuery([
      {
        digest: "sha256:abc",
        media_type: "application/octet-stream",
        size_bytes: 100,
        content_oid: 42,
        created_at: new Date("2026-01-01T00:00:00Z")
      }
    ]);
    const blob = await getRegistryBlobMeta(query, "sha256:abc");
    expect(blob).toEqual({
      digest: "sha256:abc",
      mediaType: "application/octet-stream",
      sizeBytes: 100,
      contentOid: 42,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("registry_blobs"), [
      "sha256:abc"
    ]);
  });

  it("getRegistryBlobMeta returns null when no row", async () => {
    const blob = await getRegistryBlobMeta(mockQuery([]), "sha256:missing");
    expect(blob).toBeNull();
  });

  it("insertRegistryBlob uses ON CONFLICT DO NOTHING", async () => {
    const query = mockQuery([]);
    await insertRegistryBlob(query, {
      digest: "sha256:x",
      mediaType: null,
      sizeBytes: 1,
      contentOid: 7
    });
    const [sql, params] = (query as any).mock.calls[0];
    expect(sql).toContain("ON CONFLICT");
    expect(params).toEqual(["sha256:x", null, 1, 7]);
  });

  it("deleteRegistryBlob returns the deleted row's metadata", async () => {
    const query = mockQuery([
      {
        digest: "sha256:gone",
        media_type: null,
        size_bytes: 9,
        content_oid: 11,
        created_at: "2026-01-01"
      }
    ]);
    const deleted = await deleteRegistryBlob(query, "sha256:gone");
    expect(deleted?.contentOid).toBe(11);
  });
});

describe("registry: manifest queries", () => {
  it("getRegistryManifestByDigest maps body buffer + arrays", async () => {
    const body = Buffer.from('{"schemaVersion":2}');
    const query = mockQuery([
      {
        digest: "sha256:m1",
        repo: "kaiad-agent",
        media_type: "application/vnd.docker.distribution.manifest.v2+json",
        body,
        size_bytes: body.length,
        config_digest: "sha256:cfg",
        layer_digests: ["sha256:l1", "sha256:l2"],
        referenced_manifest_digests: [],
        created_at: new Date("2026-01-01T00:00:00Z")
      }
    ]);
    const m = await getRegistryManifestByDigest(query, "sha256:m1");
    expect(m).toMatchObject({
      digest: "sha256:m1",
      repo: "kaiad-agent",
      configDigest: "sha256:cfg",
      layerDigests: ["sha256:l1", "sha256:l2"],
      referencedManifestDigests: []
    });
    expect(m?.body).toEqual(body);
  });

  it("getRegistryManifestByTag joins manifests + tags by tag", async () => {
    const query = mockQuery([
      {
        digest: "sha256:m2",
        repo: "library/alpine",
        media_type: "application/vnd.oci.image.manifest.v1+json",
        body: Buffer.from("{}"),
        size_bytes: 2,
        config_digest: null,
        layer_digests: [],
        referenced_manifest_digests: [],
        created_at: "2026-01-01"
      }
    ]);
    const m = await getRegistryManifestByTag(query, "library/alpine", "3.20");
    expect(m?.digest).toBe("sha256:m2");
    const [sql] = (query as any).mock.calls[0];
    expect(sql).toContain("JOIN registry_tags");
  });

  it("insertRegistryManifest stores body length as size_bytes", async () => {
    const query = mockQuery([]);
    const body = Buffer.from("x".repeat(123));
    await insertRegistryManifest(query, {
      digest: "sha256:d",
      repo: "r",
      mediaType: "x",
      body,
      configDigest: null,
      layerDigests: [],
      referencedManifestDigests: []
    });
    const [, params] = (query as any).mock.calls[0];
    expect(params[4]).toBe(123);
  });

  it("deleteRegistryManifest returns true when a row was deleted", async () => {
    expect(await deleteRegistryManifest(mockQuery([{ digest: "x" }]), "x")).toBe(true);
    expect(await deleteRegistryManifest(mockQuery([]), "y")).toBe(false);
  });
});

describe("registry: tag queries", () => {
  it("upsertRegistryTag uses ON CONFLICT DO UPDATE", async () => {
    const query = mockQuery([]);
    await upsertRegistryTag(query, { repo: "r", tag: "v1", manifestDigest: "sha256:m" });
    const [sql] = (query as any).mock.calls[0];
    expect(sql).toContain("ON CONFLICT (repo, tag) DO UPDATE");
  });

  it("listRegistryTagsForRepo orders by tag", async () => {
    const query = mockQuery([
      { repo: "r", tag: "v1", manifest_digest: "sha256:a", updated_at: "2026-01-01" },
      { repo: "r", tag: "v2", manifest_digest: "sha256:b", updated_at: "2026-01-02" }
    ]);
    const tags = await listRegistryTagsForRepo(query, "r");
    expect(tags.map((t) => t.tag)).toEqual(["v1", "v2"]);
    const [sql] = (query as any).mock.calls[0];
    expect(sql).toContain("ORDER BY tag");
  });

  it("deleteRegistryTag reports presence", async () => {
    expect(await deleteRegistryTag(mockQuery([{ tag: "v1" }]), "r", "v1")).toBe(true);
    expect(await deleteRegistryTag(mockQuery([]), "r", "missing")).toBe(false);
  });
});

describe("registry: catalog and uploads", () => {
  it("listRegistryRepositories returns deduped repo names", async () => {
    const query = mockQuery([{ repo: "a" }, { repo: "b/c" }, { repo: "kaiad-agent" }]);
    const repos = await listRegistryRepositories(query);
    expect(repos).toEqual(["a", "b/c", "kaiad-agent"]);
  });

  it("insertRegistryUpload writes uuid/repo/oid/expires", async () => {
    const query = mockQuery([]);
    await insertRegistryUpload(query, {
      uuid: "u1",
      repo: "r",
      contentOid: 9,
      expiresAt: "2099-01-01T00:00:00Z"
    });
    const [, params] = (query as any).mock.calls[0];
    expect(params).toEqual(["u1", "r", 9, "2099-01-01T00:00:00Z"]);
  });

  it("getRegistryUpload returns null when missing", async () => {
    expect(await getRegistryUpload(mockQuery([]), "missing")).toBeNull();
  });

  it("updateRegistryUploadReceived hits the correct SQL", async () => {
    const query = mockQuery([]);
    await updateRegistryUploadReceived(query, "u1", 500);
    const [sql, params] = (query as any).mock.calls[0];
    expect(sql).toContain("UPDATE registry_uploads");
    expect(params).toEqual(["u1", 500]);
  });

  it("deleteRegistryUpload returns the row when present", async () => {
    const query = mockQuery([
      {
        uuid: "u1",
        repo: "r",
        content_oid: 9,
        received_bytes: 100,
        expires_at: "2099-01-01",
        created_at: "2026-01-01"
      }
    ]);
    const deleted = await deleteRegistryUpload(query, "u1");
    expect(deleted?.contentOid).toBe(9);
  });

  it("listExpiredRegistryUploads filters by expires_at < now", async () => {
    const query = mockQuery([]);
    await listExpiredRegistryUploads(query, "2026-05-01T00:00:00Z");
    const [sql, params] = (query as any).mock.calls[0];
    expect(sql).toContain("expires_at <");
    expect(params).toEqual(["2026-05-01T00:00:00Z"]);
  });
});

describe("registry: pagination", () => {
  it("listRegistryRepositories applies LIMIT when limit set", async () => {
    const query = mockQuery([{ repo: "a" }, { repo: "b" }]);
    await listRegistryRepositories(query, { limit: 2 });
    const [sql, params] = (query as any).mock.calls[0];
    expect(sql).toContain("LIMIT");
    expect(params).toEqual([2]);
  });

  it("listRegistryRepositories adds WHERE repo > after when cursor set", async () => {
    const query = mockQuery([]);
    await listRegistryRepositories(query, { limit: 10, after: "kaiad-agent" });
    const [sql, params] = (query as any).mock.calls[0];
    expect(sql).toContain("WHERE repo >");
    expect(params).toEqual(["kaiad-agent", 10]);
  });

  it("listRegistryTagsForRepo applies LIMIT + after", async () => {
    const query = mockQuery([]);
    await listRegistryTagsForRepo(query, "kaiad-agent", { limit: 5, after: "v1" });
    const [sql, params] = (query as any).mock.calls[0];
    expect(sql).toContain("WHERE repo = $1 AND tag >");
    expect(sql).toContain("LIMIT");
    expect(params).toEqual(["kaiad-agent", "v1", 5]);
  });
});

describe("registry: GC helpers", () => {
  it("listOrphanRegistryBlobs uses NOT IN against referenced digests", async () => {
    const query = mockQuery([
      {
        digest: "sha256:orphan",
        media_type: null,
        size_bytes: 99,
        content_oid: 5,
        created_at: "2026-01-01"
      }
    ]);
    const orphans = await listOrphanRegistryBlobs(query);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].digest).toBe("sha256:orphan");
    const [sql] = (query as any).mock.calls[0];
    expect(sql).toContain("WITH referenced AS");
    expect(sql).toContain("NOT IN");
  });

  it("listOrphanRegistryManifests excludes tag-referenced and parent-referenced", async () => {
    const query = mockQuery([{ digest: "sha256:m", repo: "r" }]);
    const orphans = await listOrphanRegistryManifests(query);
    expect(orphans).toEqual([{ digest: "sha256:m", repo: "r" }]);
    const [sql] = (query as any).mock.calls[0];
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("registry_tags");
    expect(sql).toContain("referenced_manifest_digests");
  });
});
