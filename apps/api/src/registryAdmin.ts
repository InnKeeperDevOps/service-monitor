// Server-side helper for the panel's Registry page.
//
// The panel needs to list repositories, list tags, and delete tags. The
// OCI distribution API gives us all of that out of the box, but every
// call needs a JWT — and the registry's `auth: token` mode means we
// can't shortcut it even from inside the kaiad container. The helper
// signs admin-scoped JWTs locally (we have the private key) and makes
// HTTP requests to the registry on the docker compose network.
//
// Auth note: kaiad signs these with `subject: "kaiad-internal-admin"`
// so audit logs in the registry attribute admin actions to a fixed
// identity rather than to whichever panel session triggered them. The
// per-session caller is still recorded by Fastify's correlationId on
// the panel-side route.

import { signRegistryToken, type RegistryAccess, type RegistryAuthConfig } from "./registryAuth.js";

export type RegistryAdminConfig = {
  /** OCI distribution API base, e.g. http://registry:5000 (no trailing slash). */
  baseUrl: string;
  /** Token-signing config (key/cert paths + iss/aud). */
  auth: RegistryAuthConfig;
};

const ADMIN_SUBJECT = "kaiad-internal-admin";

function adminAccessFor(action: "catalog" | "repo-pull" | "repo-delete", name?: string): RegistryAccess[] {
  switch (action) {
    case "catalog":
      return [{ type: "registry", name: "catalog", actions: ["*"] }];
    case "repo-pull":
      if (!name) throw new Error("name required for repo-pull");
      return [{ type: "repository", name, actions: ["pull"] }];
    case "repo-delete":
      if (!name) throw new Error("name required for repo-delete");
      return [{ type: "repository", name, actions: ["pull", "delete"] }];
  }
}

async function fetchWithToken(
  config: RegistryAdminConfig,
  init: { method: string; path: string; access: RegistryAccess[]; accept?: string }
): Promise<Response> {
  const { token } = signRegistryToken(config.auth, { subject: ADMIN_SUBJECT, access: init.access });
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.accept) headers["Accept"] = init.accept;
  return fetch(`${config.baseUrl}${init.path}`, { method: init.method, headers });
}

export type RegistryRepository = {
  name: string;
};

/** List repositories (paginated by the registry; we follow `n=` once). */
export async function listRepositories(config: RegistryAdminConfig, limit = 200): Promise<RegistryRepository[]> {
  const res = await fetchWithToken(config, {
    method: "GET",
    path: `/v2/_catalog?n=${limit}`,
    access: adminAccessFor("catalog")
  });
  if (!res.ok) {
    throw new Error(`registry catalog: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { repositories?: string[] };
  return (body.repositories ?? []).map((name) => ({ name }));
}

export type RegistryTag = {
  tag: string;
  /** sha256:… for the manifest reference. Undefined if the manifest could not be fetched. */
  digest?: string;
  /** Total bytes (config + layers) when computable. */
  sizeBytes?: number;
  /** Creation time pulled from image config, if present. */
  createdAt?: string;
};

const MANIFEST_ACCEPT =
  "application/vnd.oci.image.manifest.v1+json, " +
  "application/vnd.docker.distribution.manifest.v2+json, " +
  "application/vnd.oci.image.index.v1+json, " +
  "application/vnd.docker.distribution.manifest.list.v2+json";

/** List tags for a repository, plus per-tag digest + size + created. */
export async function listTags(config: RegistryAdminConfig, name: string): Promise<RegistryTag[]> {
  const tagsRes = await fetchWithToken(config, {
    method: "GET",
    path: `/v2/${encodeURIComponent(name)}/tags/list`,
    access: adminAccessFor("repo-pull", name)
  });
  if (!tagsRes.ok) {
    throw new Error(`registry tags/list ${name}: ${tagsRes.status} ${await tagsRes.text()}`);
  }
  const tagsBody = (await tagsRes.json()) as { tags?: string[] | null };
  const tags = (tagsBody.tags ?? []).slice().sort();

  const out: RegistryTag[] = [];
  for (const tag of tags) {
    out.push(await describeTag(config, name, tag));
  }
  return out;
}

async function describeTag(
  config: RegistryAdminConfig,
  name: string,
  tag: string
): Promise<RegistryTag> {
  // HEAD gives us the digest (in Docker-Content-Digest) cheaply. GET
  // returns the manifest body so we can sum config+layer sizes.
  const res = await fetchWithToken(config, {
    method: "GET",
    path: `/v2/${encodeURIComponent(name)}/manifests/${encodeURIComponent(tag)}`,
    access: adminAccessFor("repo-pull", name),
    accept: MANIFEST_ACCEPT
  });
  if (!res.ok) {
    return { tag };
  }
  const digest = res.headers.get("docker-content-digest") ?? undefined;
  const contentType = res.headers.get("content-type") ?? "";
  const body = (await res.json()) as Record<string, unknown>;

  // For multi-arch indexes: skip size computation (we'd need to fetch
  // each per-platform manifest). A future iteration can recurse into
  // `manifests[]`.
  if (
    contentType.includes("manifest.list") ||
    contentType.includes("image.index")
  ) {
    return { tag, digest };
  }

  const config_ = body.config as { size?: number; digest?: string } | undefined;
  const layers = (body.layers ?? []) as Array<{ size?: number }>;
  const sizeBytes =
    (config_?.size ?? 0) +
    layers.reduce((acc, l) => acc + (l.size ?? 0), 0);

  // Try to read created date from the image config blob. Cheapest is
  // a separate blob fetch. If it fails, just omit createdAt.
  let createdAt: string | undefined;
  if (config_?.digest) {
    try {
      const cfgRes = await fetchWithToken(config, {
        method: "GET",
        path: `/v2/${encodeURIComponent(name)}/blobs/${encodeURIComponent(config_.digest)}`,
        access: adminAccessFor("repo-pull", name)
      });
      if (cfgRes.ok) {
        const cfgBody = (await cfgRes.json()) as { created?: string };
        createdAt = cfgBody.created;
      }
    } catch {
      /* ignore */
    }
  }

  return { tag, digest, sizeBytes, createdAt };
}

/** Resolve tag → digest, then DELETE manifest. Returns true on 202/2xx. */
export async function deleteTag(
  config: RegistryAdminConfig,
  name: string,
  tag: string
): Promise<{ deleted: boolean; digest?: string; status?: number; message?: string }> {
  // Need the digest first — registry rejects DELETE by tag.
  const head = await fetchWithToken(config, {
    method: "HEAD",
    path: `/v2/${encodeURIComponent(name)}/manifests/${encodeURIComponent(tag)}`,
    access: adminAccessFor("repo-pull", name),
    accept: MANIFEST_ACCEPT
  });
  if (!head.ok) {
    return { deleted: false, status: head.status, message: `tag not found: ${tag}` };
  }
  const digest = head.headers.get("docker-content-digest") ?? undefined;
  if (!digest) {
    return { deleted: false, message: "registry did not return a digest for the tag" };
  }
  const del = await fetchWithToken(config, {
    method: "DELETE",
    path: `/v2/${encodeURIComponent(name)}/manifests/${encodeURIComponent(digest)}`,
    access: adminAccessFor("repo-delete", name)
  });
  if (del.status === 202 || del.status === 200) {
    return { deleted: true, digest };
  }
  return { deleted: false, status: del.status, message: await del.text() };
}
