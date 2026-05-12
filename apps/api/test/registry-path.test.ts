import { describe, it, expect } from "vitest";
import { isValidDigest, parseRegistryPath } from "../src/registry/path.js";

describe("parseRegistryPath", () => {
  it("recognises ping at empty path and trailing slash", () => {
    expect(parseRegistryPath("")).toEqual({ ok: true, op: { kind: "ping" } });
    expect(parseRegistryPath("/")).toEqual({ ok: true, op: { kind: "ping" } });
  });

  it("recognises _catalog", () => {
    expect(parseRegistryPath("_catalog")).toEqual({
      ok: true,
      op: { kind: "catalog" }
    });
  });

  it("extracts repo name even when it contains slashes", () => {
    expect(parseRegistryPath("library/alpine/tags/list")).toEqual({
      ok: true,
      op: { kind: "tagsList", repo: "library/alpine" }
    });
    expect(parseRegistryPath("library/alpine/sub/tags/list")).toEqual({
      ok: true,
      op: { kind: "tagsList", repo: "library/alpine/sub" }
    });
  });

  it("parses manifests with tag references", () => {
    expect(parseRegistryPath("kaiad-agent/manifests/latest")).toEqual({
      ok: true,
      op: { kind: "manifest", repo: "kaiad-agent", reference: "latest" }
    });
  });

  it("parses manifests with digest references", () => {
    const r = parseRegistryPath(
      "kaiad-agent/manifests/sha256:" + "a".repeat(64)
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.op).toEqual({
        kind: "manifest",
        repo: "kaiad-agent",
        reference: "sha256:" + "a".repeat(64)
      });
    }
  });

  it("parses blobs by digest", () => {
    const r = parseRegistryPath("kaiad-agent/blobs/sha256:" + "b".repeat(64));
    expect(r.ok).toBe(true);
    if (r.ok && r.op.kind === "blob") {
      expect(r.op.repo).toBe("kaiad-agent");
      expect(r.op.digest).toBe("sha256:" + "b".repeat(64));
    } else {
      expect.fail("expected blob op");
    }
  });

  it("distinguishes upload init from upload session", () => {
    expect(parseRegistryPath("r/blobs/uploads/")).toEqual({
      ok: true,
      op: { kind: "uploadInit", repo: "r" }
    });
    expect(parseRegistryPath("r/blobs/uploads")).toEqual({
      ok: true,
      op: { kind: "uploadInit", repo: "r" }
    });
    expect(parseRegistryPath("r/blobs/uploads/abc-123")).toEqual({
      ok: true,
      op: { kind: "uploadSession", repo: "r", uuid: "abc-123" }
    });
  });

  it("rejects unknown shapes", () => {
    const r = parseRegistryPath("nonsense/path/no/markers");
    expect(r.ok).toBe(false);
  });
});

describe("isValidDigest", () => {
  it("accepts sha256:<64 hex>", () => {
    expect(isValidDigest("sha256:" + "0".repeat(64))).toBe(true);
  });
  it("rejects wrong length", () => {
    expect(isValidDigest("sha256:" + "0".repeat(63))).toBe(false);
    expect(isValidDigest("sha256:" + "0".repeat(65))).toBe(false);
  });
  it("rejects non-hex chars", () => {
    expect(isValidDigest("sha256:" + "g".repeat(64))).toBe(false);
  });
  it("rejects missing scheme", () => {
    expect(isValidDigest("0".repeat(64))).toBe(false);
  });
});
