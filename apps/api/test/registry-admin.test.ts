import { describe, it, expect, vi } from "vitest";
import { listRepositories, listTags, deleteTag } from "../src/registry/admin.js";
import type { QueryFn } from "@sm/db";

// SQL-routing fake queryFn — admin.ts fans out to several @sm/db
// wrappers; route by the SQL so each test is order-independent.
function router(state: {
  repos?: string[];
  tags?: { tag: string; manifest_digest: string }[];
  manifest?: Record<string, unknown> | null;
  blobSizes?: { digest: string; size_bytes: number }[];
  blobMeta?: Record<string, unknown> | null;
  otherTagExists?: boolean;
}): QueryFn {
  return vi.fn(async (sql: string) => {
    const s = String(sql);
    if (/FROM registry_tags/i.test(s) && /DISTINCT|UNION|repo/i.test(s) && !/WHERE repo/i.test(s)) {
      return { rows: (state.repos ?? []).map((repo) => ({ repo })) };
    }
    if (/FROM registry_tags WHERE repo/i.test(s) && !/DELETE/i.test(s)) {
      return {
        rows: (state.tags ?? []).map((t) => ({
          repo: "r",
          tag: t.tag,
          manifest_digest: t.manifest_digest,
          updated_at: "2026-01-01"
        }))
      };
    }
    if (/FROM registry_manifests WHERE digest/i.test(s)) {
      return { rows: state.manifest ? [state.manifest] : [] };
    }
    if (/registry_blobs WHERE digest = ANY/i.test(s)) {
      return { rows: state.blobSizes ?? [] };
    }
    if (/FROM registry_blobs WHERE digest = \$1/i.test(s)) {
      return { rows: state.blobMeta ? [state.blobMeta] : [] };
    }
    if (/DELETE FROM registry_tags/i.test(s)) return { rows: [] };
    if (/SELECT 1 FROM registry_tags WHERE manifest_digest/i.test(s)) {
      return { rows: state.otherTagExists ? [{ "?column?": 1 }] : [] };
    }
    if (/DELETE FROM registry_manifests/i.test(s)) return { rows: [] };
    return { rows: [] };
  }) as unknown as QueryFn;
}

const pool = {} as never; // openBlobReadStream is never reached (blobMeta null)

describe("registry/admin listRepositories", () => {
  it("maps repo names", async () => {
    const repos = await listRepositories(router({ repos: ["kaiad-agent", "b/c"] }));
    expect(repos).toEqual([{ name: "kaiad-agent" }, { name: "b/c" }]);
  });
});

describe("registry/admin listTags + describeTag", () => {
  it("computes size from config+layer blobs (no created date)", async () => {
    const tags = await listTags(
      pool,
      router({
        tags: [{ tag: "latest", manifest_digest: "sha256:m" }],
        manifest: {
          digest: "sha256:m",
          repo: "r",
          media_type: "application/vnd.docker.distribution.manifest.v2+json",
          body: Buffer.from("{}"),
          size_bytes: 2,
          config_digest: "sha256:cfg",
          layer_digests: ["sha256:l1", "sha256:l2"],
          referenced_manifest_digests: [],
          created_at: "2026-01-01"
        },
        blobSizes: [
          { digest: "sha256:cfg", size_bytes: 100 },
          { digest: "sha256:l1", size_bytes: 200 },
          { digest: "sha256:l2", size_bytes: 300 }
        ],
        blobMeta: null
      }),
      "r"
    );
    expect(tags).toEqual([
      { tag: "latest", digest: "sha256:m", sizeBytes: 600, createdAt: undefined }
    ]);
  });

  it("skips size for manifest lists / image indexes", async () => {
    const tags = await listTags(
      pool,
      router({
        tags: [{ tag: "idx", manifest_digest: "sha256:idx" }],
        manifest: {
          digest: "sha256:idx",
          repo: "r",
          media_type: "application/vnd.oci.image.index.v1+json",
          body: Buffer.from("{}"),
          size_bytes: 1,
          config_digest: null,
          layer_digests: [],
          referenced_manifest_digests: ["sha256:child"],
          created_at: "2026-01-01"
        }
      }),
      "r"
    );
    expect(tags).toEqual([{ tag: "idx", digest: "sha256:idx" }]);
  });

  it("returns bare tag when the manifest is missing / repo mismatch", async () => {
    const tags = await listTags(
      pool,
      router({
        tags: [{ tag: "v1", manifest_digest: "sha256:gone" }],
        manifest: null
      }),
      "r"
    );
    expect(tags).toEqual([{ tag: "v1", digest: "sha256:gone" }]);
  });
});

describe("registry/admin deleteTag", () => {
  it("returns deleted:false when the tag does not exist", async () => {
    expect(await deleteTag(router({ tags: [] }), "r", "nope")).toEqual({
      deleted: false
    });
  });

  it("deletes the manifest when no other tag references it", async () => {
    const res = await deleteTag(
      router({
        tags: [{ tag: "v1", manifest_digest: "sha256:m" }],
        otherTagExists: false
      }),
      "r",
      "v1"
    );
    expect(res).toEqual({ deleted: true, digest: "sha256:m" });
  });

  it("keeps the manifest when another tag still references it", async () => {
    const res = await deleteTag(
      router({
        tags: [{ tag: "v1", manifest_digest: "sha256:shared" }],
        otherTagExists: true
      }),
      "r",
      "v1"
    );
    expect(res).toEqual({ deleted: true, digest: "sha256:shared" });
  });
});
