// Manifest parsing for the kaiad-native registry.
//
// OCI / Docker manifests are JSON documents with three media types we
// care about:
//   1. Single-arch image manifest (Docker schema2 OR OCI image manifest):
//      { schemaVersion: 2, config: { digest }, layers: [ { digest } ] }
//   2. Image index / manifest list (multi-arch):
//      { schemaVersion: 2, manifests: [ { digest } ] }
//   3. Schema1 (legacy) — we explicitly do not support; docker stopped
//      pushing these years ago and crane won't produce them.
//
// We parse enough to extract referenced blob/manifest digests, which
// we store alongside the manifest for two reasons:
//   - validate at PUT time that the referenced blobs already exist
//     (per OCI: 400 MANIFEST_BLOB_UNKNOWN if a layer is missing)
//   - power blob/manifest GC in Phase 4

export type ParsedManifest = {
  configDigest: string | null;
  layerDigests: string[];
  referencedManifestDigests: string[];
};

/**
 * Parse a manifest body (as raw bytes) into its referenced digests.
 * Throws `ManifestParseError` on malformed JSON or unrecognized shape.
 */
export class ManifestParseError extends Error {
  constructor(
    public code: "MANIFEST_INVALID" | "MANIFEST_UNKNOWN" | "MANIFEST_BLOB_UNKNOWN",
    message: string,
    public detail?: unknown
  ) {
    super(message);
  }
}

export function parseManifest(body: Buffer, mediaType: string): ParsedManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch (err) {
    throw new ManifestParseError(
      "MANIFEST_INVALID",
      `manifest body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!doc || typeof doc !== "object") {
    throw new ManifestParseError("MANIFEST_INVALID", "manifest body is not a JSON object");
  }
  const obj = doc as Record<string, unknown>;

  // Manifest list / image index: has `manifests: [{digest}]`.
  if (Array.isArray(obj.manifests)) {
    const refs: string[] = [];
    for (const m of obj.manifests) {
      if (m && typeof m === "object" && typeof (m as any).digest === "string") {
        refs.push((m as any).digest as string);
      }
    }
    return { configDigest: null, layerDigests: [], referencedManifestDigests: refs };
  }

  // Single-arch image manifest: `config` + `layers`.
  const configDigest = readDigestField(obj.config);
  const layerDigests = readLayerDigests(obj.layers);
  if (!configDigest && layerDigests.length === 0) {
    throw new ManifestParseError(
      "MANIFEST_INVALID",
      `manifest shape unrecognized (no config/layers/manifests; media_type=${mediaType})`
    );
  }
  return {
    configDigest,
    layerDigests,
    referencedManifestDigests: []
  };
}

function readDigestField(value: unknown): string | null {
  if (value && typeof value === "object") {
    const d = (value as Record<string, unknown>).digest;
    if (typeof d === "string") return d;
  }
  return null;
}

function readLayerDigests(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const layer of value) {
    const d = readDigestField(layer);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Recognized manifest media types. Used to validate the Content-Type
 * on a PUT and to set the response Content-Type on a GET. We accept
 * the subset crane / docker push will actually send.
 */
export const KNOWN_MANIFEST_MEDIA_TYPES = new Set<string>([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json"
]);
