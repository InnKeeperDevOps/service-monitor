---
title: Built-in OCI registry
parent: Reference
nav_order: 4
---

# Built-in OCI registry

Kaiad ships a **native OCI Distribution v2 registry** served by the
same Fastify process as `/api/v1/*`. It accepts standard
`docker push` / `crane push` / `docker pull` traffic at
`<panel-host>/v2/...` and stores blobs in Postgres. There is no
`registry:2` sidecar — earlier deployments that ran one are migrated
in [Phase 3 of the rollout](#history-and-design-notes).

Source: **`apps/api/src/registry/`**.

## What it gives you

- A registry every kaiad instance hosts itself. No separate container,
  no extra Postgres, no extra port to expose.
- JWT-bearer auth identical to the docker/distribution token spec — the
  same `/registry/token` endpoint mints tokens for browsers, agents,
  the build worker, and external clients.
- Cross-repo blob mounts so a shared base image's layers don't get
  re-uploaded for every dependent build.
- Streaming reads via Postgres Large Objects — `docker pull` of a 500MB
  layer doesn't materialize the layer in the Node heap.
- A panel UI under **Registry** that lists repositories, tags, sizes,
  and creation timestamps, with admin-only delete actions.

## Endpoints

Standard OCI Distribution v1.1 subset, mounted under `/v2/`:

| Method + path | Purpose | Required scope |
|---------------|---------|----------------|
| `GET /v2/` | Auth ping (401 + Bearer challenge if unauthenticated). | (any valid token) |
| `GET /v2/_catalog` | Paginated list of repositories. | `registry:catalog:*` |
| `GET /v2/<name>/tags/list` | Paginated list of tags for `<name>`. | `repository:<name>:pull` |
| `HEAD /v2/<name>/manifests/<ref>` | Manifest exists? `<ref>` may be tag or sha256 digest. | `repository:<name>:pull` |
| `GET /v2/<name>/manifests/<ref>` | Fetch manifest body. | `repository:<name>:pull` |
| `PUT /v2/<name>/manifests/<ref>` | Push manifest; tag if `<ref>` isn't a digest. | `repository:<name>:push` |
| `DELETE /v2/<name>/manifests/<digest>` | Delete manifest by digest. | `repository:<name>:delete` |
| `HEAD /v2/<name>/blobs/<digest>` | Blob exists? | `repository:<name>:pull` |
| `GET /v2/<name>/blobs/<digest>` | Fetch blob with optional `Range:`. | `repository:<name>:pull` |
| `DELETE /v2/<name>/blobs/<digest>` | Delete blob. | `repository:<name>:delete` |
| `POST /v2/<name>/blobs/uploads/` | Start an upload session (or monolithic with `?digest=`, or cross-repo mount with `?mount=…&from=…`). | `repository:<name>:push` |
| `PATCH /v2/<name>/blobs/uploads/<uuid>` | Append a chunk. | `repository:<name>:push` |
| `PUT /v2/<name>/blobs/uploads/<uuid>?digest=<d>` | Finalize the upload with optional last chunk. | `repository:<name>:push` |
| `GET /v2/<name>/blobs/uploads/<uuid>` | Resume status (`Range: 0-<received-1>`). | `repository:<name>:push` |
| `DELETE /v2/<name>/blobs/uploads/<uuid>` | Cancel session, reclaim partial blob. | `repository:<name>:push` |

`_catalog` and `tags/list` support OCI-standard pagination: pass
`?n=<count>&last=<cursor>`; the server returns a
`Link: </v2/_catalog?n=…&last=…>; rel="next"` header when more is
available.

## Auth model

The auth flow has two shapes: external clients follow the standard
docker/distribution challenge-response; the embedded build worker
shortcuts the round trip by signing its own JWT in-process.

{::nomarkdown}
{% include mermaid-registry-auth.html %}
{:/nomarkdown}

### Token endpoint

`GET /registry/token` mints JWTs that the registry verifies on every
`/v2/*` request. The shape matches the docker/distribution token spec
(RS256, libtrust `kid`, `iss` / `aud` / `access` claims).

Callers present **Basic auth** on the token request. Three credential
classes are recognised:

| Credential | Granted access |
|-----------|----------------|
| Owner / admin kaiad session token | `pull,push,*` on any repository. |
| Enrollment token | `pull` only on any repository. |
| Anything else | 401 — no token issued. |

### `WWW-Authenticate` challenge

When a `/v2/*` request arrives without (or with an invalid) bearer
token, the server returns:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="<KAIAD_REGISTRY_REALM>",service="kaiad-registry",scope="repository:<name>:<action>"
```

The realm comes from `KAIAD_REGISTRY_REALM` (an absolute URL — set in
the compose env). Internal clients use a loopback URL like
`http://127.0.0.1:8091/registry/token`; external clients receive
whatever the operator set.

### Token TTL

Default 1 hour. Override via `REGISTRY_AUTH_TOKEN_TTL_SECONDS`. The
build worker bumps this from the docker/distribution default of 5 min
because multi-GB layer uploads can outlast a tighter window and
trigger an inconvenient mid-push 401.

### In-process JWT minting

The build worker runs in the same container as the API, so it doesn't
go through `/registry/token`. It reads the same registry-auth keypair
the verifier uses and signs its own JWTs with the appropriate scope
per build (push on the service's repo, pull on every kaiad-hosted dep).
The result is written into the per-build `docker-config.json` as a
`registrytoken` entry, bypassing the Basic-auth round-trip entirely.

This is why the prod deployment doesn't need to maintain an admin API
credential just to let builds push.

## Storage

| Table | Holds | Backend |
|------|------|---------|
| `registry_blobs` | digest → (size, content_oid, media_type) | Bytes in `pg_largeobject` referenced by `content_oid`. Streamed 64 KB at a time via `loread`/`lo_put`. Caps at the 4 TB pg_largeobject limit. |
| `registry_manifests` | digest → (repo, media_type, body, refs) | Body inline as BYTEA (manifests are KB-scale). `config_digest`, `layer_digests[]`, and `referenced_manifest_digests[]` columns enable garbage collection. |
| `registry_tags` | (repo, tag) → manifest_digest | FK to `registry_manifests` with `ON DELETE RESTRICT` — you can't reap a manifest while a tag still points at it. |
| `registry_uploads` | uuid → in-flight blob upload state | One row per active session, with `content_oid`, `received_bytes`, `expires_at`. Reaped by GC after expiry. |

Schema lives in **`packages/db/src/schema.ts`**; query helpers in
**`packages/db/src/registry.ts`**.

Storage references and the data flow on a pull:

{::nomarkdown}
{% include mermaid-blob-streaming.html %}
{:/nomarkdown}

### Why pg Large Objects (not BYTEA)?

- BYTEA caps at 1 GB per field; some image layers (ML models, fat
  composer trees) exceed that.
- BYTEA reads materialize the full value into the libpq buffer, so a
  500 MB layer pull would allocate 500 MB in the Node heap. Large
  Objects support 64 KB-chunked streaming via `loread`, keeping memory
  flat per request.
- Same `pg_dump` story, same Postgres credentials, no second database
  to operate.

## Pulling from outside the panel

### Agent / Kubelet

Agents enrolled with an **enrollment token** can use that token as the
password in a `docker login` (or as the `registrytoken` in
`config.json`). Kubernetes installs of the agent generate an
`imagePullSecrets` Secret automatically when reconciling a `KaiadAgent`
CRD — see [Kubernetes install]({% link agent/kubernetes.md %}).

The token grants **pull-only**, scoped to any repository the registry
hosts. Push from an enrollment token is rejected.

### Operator (`docker push`)

```sh
# Outside the kaiad container — uses the public realm.
echo $KAIAD_OWNER_TOKEN | docker login panel.kaiad.dev -u admin --password-stdin
docker push panel.kaiad.dev/my-image:latest
```

The owner / admin token comes from your kaiad session (visible in the
panel under **API Credentials** for long-lived programmatic access —
see [API credentials]({% link admin/api-credentials.md %})).

### CI

Pre-mint a JWT once and stick it in `~/.docker/config.json` as a
`registrytoken`:

```sh
TOKEN=$(curl -sf -u admin:$KAIAD_TOKEN \
  "https://panel.kaiad.dev/registry/token?service=kaiad-registry&scope=repository:my-image:push,pull" \
  | jq -r .token)

cat > ~/.docker/config.json <<JSON
{ "auths": { "panel.kaiad.dev": { "registrytoken": "$TOKEN" } } }
JSON

crane push my-image.tar panel.kaiad.dev/my-image:v1
```

Tokens are short-lived (1 h by default). For long-running CI use the
Basic-auth path so crane re-mints automatically when the JWT expires.

## The Registry panel page

Lists every repository known to the local Postgres, with expandable
rows showing per-tag info: tag name, manifest digest, total size
(config + layers), creation date.

Behind the scenes the page calls
`GET /api/v1/registry/repositories` and
`GET /api/v1/registry/repositories/:name/tags`. Those endpoints read
the same Postgres tables the `/v2/*` server uses — no separate registry
HTTP call.

Admin users see a **delete** action per tag. Deleting a tag drops the
mapping immediately; the underlying manifest and blobs become candidates
for the next GC sweep.

## Garbage collection

Run-once CLI:

```sh
pnpm --filter @sm/api registry:gc
```

In order, the sweep reclaims:

1. **Expired upload sessions** — `registry_uploads` rows with
   `expires_at < now()`. The partial blob's `content_oid` is unlinked.
2. **Orphan manifests** — manifests with no tag pointing at them AND
   not referenced by any manifest list. Deleted.
3. **Orphan blobs** — `registry_blobs` rows whose digest isn't in any
   manifest's `config_digest` or `layer_digests`. Row removed,
   `content_oid` unlinked.

Run order matters: deleting manifests first lets blob GC pick up
newly-orphaned blobs in the same pass.

Output:

```
[gc] scanning expired uploads (now=2026-05-12T07:30:00.000Z)
[gc] reclaimed 0 expired upload(s)
[gc] scanning orphan manifests
[gc] reclaimed 3 orphan manifest(s)
[gc] scanning orphan blobs
[gc] reclaimed 12 orphan blob(s), 1574826452 bytes

expiredUploadsReclaimed: 0
orphanManifestsReclaimed: 3
orphanBlobsReclaimed: 12
bytesReclaimed: 1574826452
```

GC is idempotent and safe to run while the registry serves traffic —
every step uses single-row deletes (no global locks). A race against
an in-flight push at worst surfaces a 404 on a blob the push was about
to reference, and the crane retry will succeed on the next attempt.

There's no built-in cron yet; wire it into your own scheduler (k8s
CronJob, systemd timer, a `/loop` skill, etc.).

## Compose env vars

Used by both the API (verifier) and the build worker (signer):

| Var | Default | Notes |
|----|---------|-------|
| `KAIAD_REGISTRY_HOST` | `panel.dev.kaiad.dev` | External hostname recorded in image refs and pulled by agents. |
| `KAIAD_REGISTRY_INTERNAL` | same as `KAIAD_REGISTRY_HOST` | Loopback hostname the build worker pushes to. Compose default: `127.0.0.1:<PORT>`. |
| `KAIAD_REGISTRY_REALM` | `/registry/token` (relative) | **Set this to an absolute URL.** Crane's Go HTTP client rejects relative realm URLs. Compose default: `http://127.0.0.1:<PORT>/registry/token`. |
| `KAIAD_REGISTRY_PUSH_USER` / `KAIAD_REGISTRY_PUSH_PASSWORD` | `admin` / `dev-token` | Fallback Basic-auth credentials used only when the worker can't find the registry-auth keypair on disk (standalone worker, not embedded). |
| `REGISTRY_AUTH_KEY_PATH` | `<DATA_DIR>/registry-auth/key.pem` | Private signing key. Generated on first boot if missing. |
| `REGISTRY_AUTH_CERT_PATH` | `<DATA_DIR>/registry-auth/cert.pem` | Public cert; libtrust `kid` is derived from the SPKI. |
| `REGISTRY_AUTH_ISSUER` | `kaiad` | JWT `iss` claim. |
| `REGISTRY_AUTH_SERVICE` | `kaiad-registry` | JWT `aud` claim. |
| `REGISTRY_AUTH_TOKEN_TTL_SECONDS` | `3600` | Token lifetime. |

The dev and prod compose files under `env/` show the full wiring.

## History and design notes

Originally the registry was a `registry:2` sidecar — see the commit
chain starting at `83728ed feat(registry): bring up an OCI registry
alongside the dev stack` and ending with the Phase-3 cutover commits.
The sidecar served `/v2/*` directly and Kaiad's API only managed JWT
minting + a couple of admin proxy endpoints.

The native implementation replaced the sidecar in May 2026. Motivation:

- One process to operate. No second container to ship, restart, or
  observe.
- Direct DB access for the panel's admin endpoints — no HTTP round
  trip through the registry just to list tags.
- Tight integration with the build worker: minting tokens in-process
  removes the need to provision an admin credential just so internal
  builds can push.
- A single content-addressable storage layer (Postgres) instead of two
  (Postgres + a registry's filesystem volume).

The four-phase rollout — schema + read path, write path, cutover,
polish — is described in the commit history under `feat:` and
`feat(registry):` messages.

## See also

- [`kaiad.yaml` reference]({% link reference/pipeline.md %})
- [Pipeline variables]({% link reference/pipeline-variables.md %}) —
  including `{kaiad_registry_host}`.
- [Onboarding a service]({% link getting-started/onboarding-services.md %})
