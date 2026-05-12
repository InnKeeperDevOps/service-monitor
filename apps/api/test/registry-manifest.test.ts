import { describe, it, expect } from "vitest";
import {
  KNOWN_MANIFEST_MEDIA_TYPES,
  ManifestParseError,
  parseManifest
} from "../src/registry/manifest.js";

const SINGLE_ARCH = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: {
      mediaType: "application/vnd.docker.container.image.v1+json",
      digest: "sha256:" + "c".repeat(64),
      size: 1234
    },
    layers: [
      {
        mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
        digest: "sha256:" + "a".repeat(64),
        size: 5000
      },
      {
        mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
        digest: "sha256:" + "b".repeat(64),
        size: 7000
      }
    ]
  })
);

const MANIFEST_LIST = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: "sha256:" + "1".repeat(64),
        platform: { architecture: "amd64", os: "linux" }
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: "sha256:" + "2".repeat(64),
        platform: { architecture: "arm64", os: "linux" }
      }
    ]
  })
);

describe("parseManifest", () => {
  it("extracts config + layer digests from single-arch manifest", () => {
    const parsed = parseManifest(
      SINGLE_ARCH,
      "application/vnd.docker.distribution.manifest.v2+json"
    );
    expect(parsed.configDigest).toBe("sha256:" + "c".repeat(64));
    expect(parsed.layerDigests).toEqual([
      "sha256:" + "a".repeat(64),
      "sha256:" + "b".repeat(64)
    ]);
    expect(parsed.referencedManifestDigests).toEqual([]);
  });

  it("extracts referenced manifests from a manifest list", () => {
    const parsed = parseManifest(MANIFEST_LIST, "application/vnd.oci.image.index.v1+json");
    expect(parsed.configDigest).toBeNull();
    expect(parsed.layerDigests).toEqual([]);
    expect(parsed.referencedManifestDigests).toEqual([
      "sha256:" + "1".repeat(64),
      "sha256:" + "2".repeat(64)
    ]);
  });

  it("throws MANIFEST_INVALID on bad JSON", () => {
    expect(() =>
      parseManifest(Buffer.from("not json"), "application/vnd.oci.image.manifest.v1+json")
    ).toThrow(ManifestParseError);
  });

  it("throws MANIFEST_INVALID when shape lacks config/layers/manifests", () => {
    try {
      parseManifest(
        Buffer.from(JSON.stringify({ schemaVersion: 2 })),
        "application/vnd.docker.distribution.manifest.v2+json"
      );
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestParseError);
      expect((err as ManifestParseError).code).toBe("MANIFEST_INVALID");
    }
  });

  it("ignores layer entries without a digest field", () => {
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        config: { digest: "sha256:" + "c".repeat(64) },
        layers: [
          { digest: "sha256:" + "a".repeat(64) },
          { mediaType: "x" }, // no digest — skipped
          { digest: "sha256:" + "b".repeat(64) }
        ]
      })
    );
    const parsed = parseManifest(body, "application/vnd.docker.distribution.manifest.v2+json");
    expect(parsed.layerDigests).toEqual([
      "sha256:" + "a".repeat(64),
      "sha256:" + "b".repeat(64)
    ]);
  });
});

describe("KNOWN_MANIFEST_MEDIA_TYPES", () => {
  it("includes the four media types crane / docker push emit", () => {
    expect(KNOWN_MANIFEST_MEDIA_TYPES.has("application/vnd.docker.distribution.manifest.v2+json")).toBe(true);
    expect(KNOWN_MANIFEST_MEDIA_TYPES.has("application/vnd.docker.distribution.manifest.list.v2+json")).toBe(true);
    expect(KNOWN_MANIFEST_MEDIA_TYPES.has("application/vnd.oci.image.manifest.v1+json")).toBe(true);
    expect(KNOWN_MANIFEST_MEDIA_TYPES.has("application/vnd.oci.image.index.v1+json")).toBe(true);
  });
});
