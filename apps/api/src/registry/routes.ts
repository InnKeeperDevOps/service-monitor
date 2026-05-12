// OCI Distribution v2 routes — kaiad-native implementation.
//
// Mounted at /v2 in apps/api so docker/crane/podman can pull and push
// against panel.kaiad.dev/v2/... without a separate registry daemon.
//
// Routes:
//   GET    /v2/                                              ping
//   GET    /v2/_catalog                                      catalog
//   GET    /v2/<name>/tags/list                              tags
//   HEAD   /v2/<name>/manifests/<ref>                        manifest existence
//   GET    /v2/<name>/manifests/<ref>                        manifest fetch
//   PUT    /v2/<name>/manifests/<ref>                        manifest push
//   DELETE /v2/<name>/manifests/<ref>                        manifest delete
//   HEAD   /v2/<name>/blobs/<digest>                         blob existence
//   GET    /v2/<name>/blobs/<digest>                         blob fetch (Range OK)
//   DELETE /v2/<name>/blobs/<digest>                         blob delete
//   POST   /v2/<name>/blobs/uploads/                         start upload OR
//                                                            ?digest=… (monolithic) OR
//                                                            ?mount=…&from=… (cross-repo)
//   GET    /v2/<name>/blobs/uploads/<uuid>                   upload status
//   PATCH  /v2/<name>/blobs/uploads/<uuid>                   append chunk
//   PUT    /v2/<name>/blobs/uploads/<uuid>?digest=…          finalize (with optional final chunk)
//   DELETE /v2/<name>/blobs/uploads/<uuid>                   cancel
//
// Auth: every protected route either 401s with a WWW-Authenticate Bearer
// challenge that points clients at /registry/token, or accepts a valid
// JWT issued by the minter in apps/api/src/server.ts.

import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
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
  listRegistryRepositories,
  listRegistryTagsForRepo,
  updateRegistryUploadReceived,
  upsertRegistryTag,
  type QueryFn,
  type RegistryUploadRow
} from "@sm/db";
import type { RegistryAuthConfig } from "@sm/registry-auth";
import {
  buildAuthChallenge,
  grantAllows,
  verifyRegistryToken,
  type RegistryVerifyOk,
  type RequiredScope
} from "./auth.js";
import { isValidDigest, parseRegistryPath, type RegistryOp } from "./path.js";
import {
  blobOidSize,
  computeBlobDigest,
  createBlobOid,
  openBlobReadStream,
  streamWriteBlob,
  unlinkBlobOid
} from "./blobStorage.js";
import {
  KNOWN_MANIFEST_MEDIA_TYPES,
  ManifestParseError,
  parseManifest
} from "./manifest.js";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type RegistryRoutesDeps = {
  /**
   * Lazy pool getter. Registry routes need Postgres; if this returns
   * null (DATABASE_URL unset, init failed, etc.) handlers respond 503.
   * Pattern matches the lazy builds pool in server.ts.
   */
  getPool: () => Promise<Pool | null>;
  /** JWT verifier/minter config. Same instance used by /registry/token. */
  authConfig: RegistryAuthConfig;
  /**
   * URL used as the `realm` in WWW-Authenticate challenges. Clients call
   * this with Basic auth and ?scope= to obtain a bearer token. Typically
   * `https://panel.kaiad.dev/registry/token`.
   */
  tokenRealm: string;
  /** `service` value clients should ask for. Default matches the minter. */
  service?: string;
};

export function registerRegistryRoutes(
  app: FastifyInstance,
  deps: RegistryRoutesDeps
): void {
  const service = deps.service ?? deps.authConfig.service;

  // ── Content-type parsers for write routes ──────────────────────────
  // Fastify's default JSON parser would mutate manifest bytes (e.g.
  // re-ordering keys, dropping whitespace), which would change the
  // manifest's sha256 digest and break content-addressing. We register
  // buffer parsers for the known manifest media types so PUT handlers
  // get the exact bytes the client sent.
  //
  // For blob uploads (PATCH / PUT / POST) we register a pass-through
  // stream parser on application/octet-stream so the handler can
  // consume the body as an async-iterable of Buffer chunks and stream
  // directly to pg_largeobject without buffering the whole upload in
  // memory.
  for (const mt of KNOWN_MANIFEST_MEDIA_TYPES) {
    // Idempotent: addContentTypeParser throws if a parser is already
    // registered for this content type — `hasContentTypeParser` lets
    // us skip in case the function is called twice in test setup.
    if (!app.hasContentTypeParser(mt)) {
      app.addContentTypeParser(
        mt,
        { parseAs: "buffer", bodyLimit: 64 * 1024 * 1024 },
        (_req, body, done) => done(null, body)
      );
    }
  }
  // Pass-through parser for blob upload bodies. Handler reads req.body
  // (the raw stream) directly. bodyLimit doesn't apply when we hand
  // back the stream as-is.
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser(
      "application/octet-stream",
      (_req, payload, done) => done(null, payload)
    );
  }
  // Lenient JSON parser. Crane (and other OCI clients) send
  // `Content-Type: application/json` with an empty body on
  // `POST /v2/<name>/blobs/uploads/` — that's just a session-start
  // signal, not a JSON payload. Fastify's default JSON parser
  // FST_ERR_CTP_EMPTY_JSON_BODY-rejects this; the lenient replacement
  // returns `undefined` for empty bodies and otherwise parses as
  // usual. Other routes in the app that expect JSON have Zod schema
  // validation that surfaces a 400 for missing fields anyway, so this
  // replacement doesn't loosen error reporting elsewhere.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (!body || (typeof body === "string" && body.length === 0)) {
        return done(null, undefined);
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    }
  );

  const queryWith =
    (pool: Pool): QueryFn =>
    async (sql, params) => {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows as Record<string, unknown>[] };
    };

  async function withPool(
    reply: FastifyReply
  ): Promise<{ pool: Pool; queryFn: QueryFn } | null> {
    const pool = await deps.getPool();
    if (!pool) {
      sendOciError(
        reply,
        503,
        "UNAVAILABLE",
        "Registry storage not configured (DATABASE_URL missing)"
      );
      return null;
    }
    return { pool, queryFn: queryWith(pool) };
  }

  // Send an OCI-shaped error body. The spec defines a small set of
  // codes; for non-spec internal failures we use "DENIED" as a
  // catch-all so docker clients display *something* useful.
  function sendOciError(
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    detail?: unknown
  ): FastifyReply {
    return reply
      .status(status)
      .header("content-type", "application/json")
      .send({ errors: [{ code, message, detail }] });
  }

  function challenge(reply: FastifyReply, scopes: RequiredScope[]): FastifyReply {
    reply.header(
      "WWW-Authenticate",
      buildAuthChallenge({ realm: deps.tokenRealm, service, scopes })
    );
    return reply;
  }

  function requireAuth(
    req: FastifyRequest,
    reply: FastifyReply,
    needed: RequiredScope[]
  ): RegistryVerifyOk | null {
    const result = verifyRegistryToken(req.headers.authorization, deps.authConfig, {
      audience: service
    });
    if (!result.ok) {
      challenge(reply, needed);
      sendOciError(reply, 401, "UNAUTHORIZED", `Auth required: ${result.message}`);
      return null;
    }
    for (const need of needed) {
      if (!grantAllows(result, need)) {
        challenge(reply, needed);
        sendOciError(
          reply,
          403,
          "DENIED",
          `Token lacks ${need.action} access to ${need.type}:${need.name}`
        );
        return null;
      }
    }
    return result;
  }

  // ── GET /v2/ — ping ─────────────────────────────────────────────────
  // Per the distribution spec: 200 if authenticated, 401 with a Bearer
  // challenge if not. Docker uses this to discover the realm.
  app.get("/v2/", async (req, reply) => {
    const result = verifyRegistryToken(req.headers.authorization, deps.authConfig, {
      audience: service
    });
    if (!result.ok) {
      challenge(reply, []);
      return sendOciError(reply, 401, "UNAUTHORIZED", "Authentication required");
    }
    return reply.status(200).header("Docker-Distribution-API-Version", "registry/2.0").send({});
  });

  // ── /v2/* — dispatcher ──────────────────────────────────────────────
  // Single wildcard route per method. We parse the remainder manually
  // because OCI repo names contain literal slashes.

  function parseOrError(
    req: FastifyRequest,
    reply: FastifyReply
  ): RegistryOp | null {
    const wildcard = (req.params as { "*"?: string })["*"] ?? "";
    const parsed = parseRegistryPath(wildcard);
    if (!parsed.ok) {
      sendOciError(reply, 404, "NAME_UNKNOWN", parsed.reason);
      return null;
    }
    return parsed.op;
  }

  // GET + HEAD share a handler that branches on req.method. Fastify v5
  // auto-creates a HEAD route from each GET — passing both methods to
  // app.route() (and disabling exposeHeadRoute) avoids the double-
  // registration conflict.
  app.route({
    method: ["GET", "HEAD"],
    url: "/v2/*",
    exposeHeadRoute: false,
    handler: (req, reply) => handle(req.method === "HEAD" ? "HEAD" : "GET", req, reply)
  });

  // POST: upload init (new session / monolithic / cross-repo mount).
  app.route({
    method: "POST",
    url: "/v2/*",
    bodyLimit: 64 * 1024 * 1024 * 1024, // 64GB monolithic-upload ceiling
    handler: async (req, reply) => {
      const op = parseOrError(req, reply);
      if (!op) return reply;
      if (op.kind === "uploadInit") return uploadInitHandler(req, reply, op);
      return sendOciError(reply, 405, "UNSUPPORTED", `POST not allowed on ${op.kind}`);
    }
  });

  // PUT: either manifest push (with manifest media type) or upload
  // commit (PUT on an existing upload session).
  app.route({
    method: "PUT",
    url: "/v2/*",
    bodyLimit: 64 * 1024 * 1024 * 1024,
    handler: async (req, reply) => {
      const op = parseOrError(req, reply);
      if (!op) return reply;
      if (op.kind === "manifest") return manifestPutHandler(req, reply, op);
      if (op.kind === "uploadSession") return uploadCompleteHandler(req, reply, op);
      return sendOciError(reply, 405, "UNSUPPORTED", `PUT not allowed on ${op.kind}`);
    }
  });

  // PATCH: append a chunk to an upload session.
  app.route({
    method: "PATCH",
    url: "/v2/*",
    bodyLimit: 64 * 1024 * 1024 * 1024,
    handler: async (req, reply) => {
      const op = parseOrError(req, reply);
      if (!op) return reply;
      if (op.kind === "uploadSession") return uploadPatchHandler(req, reply, op);
      return sendOciError(reply, 405, "UNSUPPORTED", `PATCH not allowed on ${op.kind}`);
    }
  });

  // DELETE: manifest, blob, or upload-cancel.
  app.delete("/v2/*", async (req, reply) => {
    const op = parseOrError(req, reply);
    if (!op) return reply;
    if (op.kind === "manifest") return manifestDeleteHandler(req, reply, op);
    if (op.kind === "blob") return blobDeleteHandler(req, reply, op);
    if (op.kind === "uploadSession") return uploadCancelHandler(req, reply, op);
    return sendOciError(reply, 405, "UNSUPPORTED", `DELETE not allowed on ${op.kind}`);
  });

  async function handle(method: "GET" | "HEAD", req: FastifyRequest, reply: FastifyReply) {
    const op = parseOrError(req, reply);
    if (!op) return reply;

    switch (op.kind) {
      case "ping":
        // Already handled by /v2/ route, but the wildcard may catch
        // /v2 (no trailing slash) routed here by Fastify. Treat the
        // same.
        return await pingHandler(req, reply);
      case "catalog":
        return await catalogHandler(req, reply);
      case "tagsList":
        return await tagsListHandler(req, reply, op);
      case "manifest":
        return await manifestHandler(method, req, reply, op);
      case "blob":
        return await blobHandler(method, req, reply, op);
      case "uploadSession":
        return await uploadStatusHandler(req, reply, op);
      case "uploadInit":
        return sendOciError(reply, 405, "UNSUPPORTED", `${method} not allowed on uploadInit`);
      default:
        return sendOciError(reply, 404, "NAME_UNKNOWN", "Unhandled /v2 path");
    }
  }

  async function pingHandler(req: FastifyRequest, reply: FastifyReply) {
    const result = verifyRegistryToken(req.headers.authorization, deps.authConfig, {
      audience: service
    });
    if (!result.ok) {
      challenge(reply, []);
      return sendOciError(reply, 401, "UNAUTHORIZED", "Authentication required");
    }
    return reply.status(200).header("Docker-Distribution-API-Version", "registry/2.0").send({});
  }

  async function catalogHandler(req: FastifyRequest, reply: FastifyReply) {
    // _catalog needs registry-wide access. We grant this only to
    // admin/owner kaiad sessions via the token minter. Phase 1 emits
    // the scope literally; the minter's logic in server.ts already
    // chooses whether to grant it.
    const grant = requireAuth(req, reply, [
      { type: "registry", name: "catalog", action: "*" }
    ]);
    if (!grant) return reply;
    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const { limit, after } = parsePagination(req);
    const repositories = await listRegistryRepositories(ctx.queryFn, {
      limit,
      after
    });
    // Emit a Link: <…>; rel="next" only when the page filled — that's
    // the standard signal in the OCI spec that more is available.
    if (limit != null && repositories.length === limit) {
      const last = repositories[repositories.length - 1];
      reply.header(
        "Link",
        `</v2/_catalog?n=${limit}&last=${encodeURIComponent(last)}>; rel="next"`
      );
    }
    return reply.status(200).header("content-type", "application/json").send({ repositories });
  }

  async function tagsListHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "tagsList" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "pull" }
    ]);
    if (!grant) return reply;
    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const { limit, after } = parsePagination(req);
    const tags = await listRegistryTagsForRepo(ctx.queryFn, op.repo, {
      limit,
      after
    });
    if (limit != null && tags.length === limit) {
      const last = tags[tags.length - 1].tag;
      reply.header(
        "Link",
        `</v2/${op.repo}/tags/list?n=${limit}&last=${encodeURIComponent(last)}>; rel="next"`
      );
    }
    return reply
      .status(200)
      .header("content-type", "application/json")
      .send({ name: op.repo, tags: tags.map((t) => t.tag) });
  }

  async function manifestHandler(
    method: "GET" | "HEAD",
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "manifest" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "pull" }
    ]);
    if (!grant) return reply;
    const ctx = await withPool(reply);
    if (!ctx) return reply;

    const manifest = isValidDigest(op.reference)
      ? await getRegistryManifestByDigest(ctx.queryFn, op.reference)
      : await getRegistryManifestByTag(ctx.queryFn, op.repo, op.reference);

    if (!manifest || manifest.repo !== op.repo) {
      return sendOciError(reply, 404, "MANIFEST_UNKNOWN", `manifest unknown: ${op.reference}`);
    }

    reply
      .header("Docker-Content-Digest", manifest.digest)
      .header("content-type", manifest.mediaType)
      .header("content-length", String(manifest.sizeBytes));
    if (method === "HEAD") {
      return reply.status(200).send();
    }
    return reply.status(200).send(manifest.body);
  }

  async function blobHandler(
    method: "GET" | "HEAD",
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "blob" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "pull" }
    ]);
    if (!grant) return reply;
    if (!isValidDigest(op.digest)) {
      return sendOciError(reply, 400, "DIGEST_INVALID", `not a valid digest: ${op.digest}`);
    }
    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const blob = await getRegistryBlobMeta(ctx.queryFn, op.digest);
    if (!blob) {
      return sendOciError(reply, 404, "BLOB_UNKNOWN", `blob unknown: ${op.digest}`);
    }

    // Parse Range header (single byte range only — multipart range is not
    // required by the OCI spec).
    const range = parseRangeHeader(req.headers.range as string | undefined, blob.sizeBytes);
    if (range === "invalid") {
      reply.header("content-range", `bytes */${blob.sizeBytes}`);
      return sendOciError(reply, 416, "RANGE_INVALID", "invalid Range header");
    }

    const contentLength = range ? range.end - range.start + 1 : blob.sizeBytes;
    reply
      .header("Docker-Content-Digest", blob.digest)
      .header("content-type", blob.mediaType ?? "application/octet-stream")
      .header("content-length", String(contentLength))
      .header("accept-ranges", "bytes");
    if (range) {
      reply.header("content-range", `bytes ${range.start}-${range.end}/${blob.sizeBytes}`);
    }
    if (method === "HEAD") {
      return reply.status(200).send();
    }

    const stream = await openBlobReadStream(ctx.pool, blob.contentOid, {
      range: range ? { start: range.start, end: range.end } : undefined
    });
    if (!stream) {
      // Blob row exists but oid was reaped/missing — treat as 404.
      return sendOciError(reply, 404, "BLOB_UNKNOWN", `blob bytes missing for ${op.digest}`);
    }
    return reply.status(range ? 206 : 200).send(stream);
  }

  // ── Write handlers ────────────────────────────────────────────────

  async function manifestPutHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "manifest" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "push" }
    ]);
    if (!grant) return reply;

    const contentType = String(req.headers["content-type"] ?? "");
    const mediaType = contentType.split(";")[0].trim();
    if (!KNOWN_MANIFEST_MEDIA_TYPES.has(mediaType)) {
      return sendOciError(
        reply,
        415,
        "MANIFEST_INVALID",
        `unsupported manifest media type: ${mediaType || "<missing>"}`
      );
    }
    if (!Buffer.isBuffer(req.body)) {
      // Either fastify didn't call our buffer parser (mismatch on
      // Content-Type) or the body is empty.
      return sendOciError(reply, 400, "MANIFEST_INVALID", "manifest body missing or not buffered");
    }
    const body = req.body as Buffer;
    if (body.length === 0) {
      return sendOciError(reply, 400, "MANIFEST_INVALID", "manifest body is empty");
    }

    let parsed;
    try {
      parsed = parseManifest(body, mediaType);
    } catch (err) {
      if (err instanceof ManifestParseError) {
        return sendOciError(reply, 400, err.code, err.message, err.detail);
      }
      throw err;
    }

    const ctx = await withPool(reply);
    if (!ctx) return reply;

    // Validate referenced blobs exist. Per OCI: 400 MANIFEST_BLOB_UNKNOWN.
    const allBlobRefs = [
      ...(parsed.configDigest ? [parsed.configDigest] : []),
      ...parsed.layerDigests
    ];
    for (const digest of allBlobRefs) {
      const meta = await getRegistryBlobMeta(ctx.queryFn, digest);
      if (!meta) {
        return sendOciError(
          reply,
          400,
          "MANIFEST_BLOB_UNKNOWN",
          `referenced blob missing: ${digest}`,
          { digest }
        );
      }
    }
    // For manifest lists, the referenced manifests must also exist.
    for (const digest of parsed.referencedManifestDigests) {
      const m = await getRegistryManifestByDigest(ctx.queryFn, digest);
      if (!m) {
        return sendOciError(
          reply,
          400,
          "MANIFEST_UNKNOWN",
          `referenced manifest missing: ${digest}`,
          { digest }
        );
      }
    }

    const digest = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
    await insertRegistryManifest(ctx.queryFn, {
      digest,
      repo: op.repo,
      mediaType,
      body,
      configDigest: parsed.configDigest,
      layerDigests: parsed.layerDigests,
      referencedManifestDigests: parsed.referencedManifestDigests
    });

    // If the reference was a tag (not a digest), update the tag to
    // point at this manifest.
    if (!isValidDigest(op.reference)) {
      await upsertRegistryTag(ctx.queryFn, {
        repo: op.repo,
        tag: op.reference,
        manifestDigest: digest
      });
    }

    return reply
      .status(201)
      .header("Docker-Content-Digest", digest)
      .header("Location", `/v2/${op.repo}/manifests/${digest}`)
      .send();
  }

  async function manifestDeleteHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "manifest" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "delete" }
    ]);
    if (!grant) return reply;
    const ctx = await withPool(reply);
    if (!ctx) return reply;

    // OCI spec: DELETE manifest only accepts digest references. Tag
    // deletion uses a different (recently added) endpoint that we
    // don't implement yet.
    if (!isValidDigest(op.reference)) {
      return sendOciError(
        reply,
        405,
        "UNSUPPORTED",
        "DELETE by tag not supported; delete by digest"
      );
    }
    const existing = await getRegistryManifestByDigest(ctx.queryFn, op.reference);
    if (!existing || existing.repo !== op.repo) {
      return sendOciError(reply, 404, "MANIFEST_UNKNOWN", `manifest unknown: ${op.reference}`);
    }
    // Tags pointing at this digest must be removed first (the FK has
    // ON DELETE RESTRICT). Delete them, then the manifest.
    const tags = await listRegistryTagsForRepo(ctx.queryFn, op.repo);
    for (const t of tags) {
      if (t.manifestDigest === op.reference) {
        await deleteRegistryTag(ctx.queryFn, op.repo, t.tag);
      }
    }
    await deleteRegistryManifest(ctx.queryFn, op.reference);
    return reply.status(202).send();
  }

  async function blobDeleteHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "blob" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "delete" }
    ]);
    if (!grant) return reply;
    if (!isValidDigest(op.digest)) {
      return sendOciError(reply, 400, "DIGEST_INVALID", `not a valid digest: ${op.digest}`);
    }
    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const existing = await getRegistryBlobMeta(ctx.queryFn, op.digest);
    if (!existing) {
      return sendOciError(reply, 404, "BLOB_UNKNOWN", `blob unknown: ${op.digest}`);
    }
    // Row deletion + lo_unlink in two statements. Not atomic — a crash
    // between them could leave a dangling lo. GC sweeps that in Phase 4.
    await deleteRegistryBlob(ctx.queryFn, op.digest);
    await unlinkBlobOid(ctx.pool, existing.contentOid).catch(() => undefined);
    return reply.status(202).send();
  }

  // ── Upload session handlers ───────────────────────────────────────

  async function uploadInitHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "uploadInit" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "push" }
    ]);
    if (!grant) return reply;

    const q = req.query as Record<string, string | undefined>;
    const mountDigest = q.mount;
    const mountFrom = q.from;
    const finalDigest = q.digest;

    const ctx = await withPool(reply);
    if (!ctx) return reply;

    // Case 1: cross-repo mount — if the blob already exists, return
    // 201 immediately with the new repo's blob URL. The `from` param
    // is informational; per spec the server may use it to authorize
    // but we accept any source repo (all repos in our registry are
    // globally addressable today).
    if (mountDigest && mountFrom) {
      if (!isValidDigest(mountDigest)) {
        return sendOciError(reply, 400, "DIGEST_INVALID", `not a valid digest: ${mountDigest}`);
      }
      const existing = await getRegistryBlobMeta(ctx.queryFn, mountDigest);
      if (existing) {
        return reply
          .status(201)
          .header("Location", `/v2/${op.repo}/blobs/${mountDigest}`)
          .header("Docker-Content-Digest", mountDigest)
          .send();
      }
      // Per spec: if mount fails, fall through to a normal upload session.
    }

    // Case 2: monolithic upload — POST with ?digest=<d> and the
    // complete body in this request.
    if (finalDigest) {
      if (!isValidDigest(finalDigest)) {
        return sendOciError(reply, 400, "DIGEST_INVALID", `not a valid digest: ${finalDigest}`);
      }
      return await commitMonolithicUpload(req, reply, ctx, op.repo, finalDigest);
    }

    // Case 3: new upload session.
    const oid = await createBlobOid(ctx.pool);
    const uuid = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
    await insertRegistryUpload(ctx.queryFn, {
      uuid,
      repo: op.repo,
      contentOid: oid,
      expiresAt
    });
    return reply
      .status(202)
      .header("Location", `/v2/${op.repo}/blobs/uploads/${uuid}`)
      .header("Docker-Upload-UUID", uuid)
      .header("Range", "0-0")
      .send();
  }

  async function commitMonolithicUpload(
    req: FastifyRequest,
    reply: FastifyReply,
    ctx: { pool: Pool; queryFn: QueryFn },
    repo: string,
    expectedDigest: string
  ) {
    const oid = await createBlobOid(ctx.pool);
    const body = req.body;
    const stream = bodyToStream(body);
    if (!stream) {
      await unlinkBlobOid(ctx.pool, oid).catch(() => undefined);
      return sendOciError(reply, 400, "BLOB_UPLOAD_INVALID", "request body missing");
    }
    try {
      await streamWriteBlob(ctx.pool, oid, 0, stream);
    } catch (err) {
      await unlinkBlobOid(ctx.pool, oid).catch(() => undefined);
      throw err;
    }
    const { digest, size } = await computeBlobDigest(ctx.pool, oid);
    if (digest !== expectedDigest) {
      await unlinkBlobOid(ctx.pool, oid).catch(() => undefined);
      return sendOciError(
        reply,
        400,
        "DIGEST_INVALID",
        `uploaded bytes digest ${digest} does not match expected ${expectedDigest}`
      );
    }
    await insertRegistryBlob(ctx.queryFn, {
      digest,
      mediaType: String(req.headers["content-type"] ?? null) || null,
      sizeBytes: size,
      contentOid: oid
    });
    return reply
      .status(201)
      .header("Location", `/v2/${repo}/blobs/${digest}`)
      .header("Docker-Content-Digest", digest)
      .send();
  }

  async function uploadStatusHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "uploadSession" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "push" }
    ]);
    if (!grant) return reply;
    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const upload = await getRegistryUpload(ctx.queryFn, op.uuid);
    if (!upload || upload.repo !== op.repo) {
      return sendOciError(reply, 404, "BLOB_UPLOAD_UNKNOWN", `upload not found: ${op.uuid}`);
    }
    return reply
      .status(204)
      .header("Location", `/v2/${op.repo}/blobs/uploads/${op.uuid}`)
      .header("Range", `0-${Math.max(0, upload.receivedBytes - 1)}`)
      .header("Docker-Upload-UUID", op.uuid)
      .send();
  }

  async function uploadPatchHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "uploadSession" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "push" }
    ]);
    if (!grant) return reply;
    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const upload = await getRegistryUpload(ctx.queryFn, op.uuid);
    if (!upload || upload.repo !== op.repo) {
      return sendOciError(reply, 404, "BLOB_UPLOAD_UNKNOWN", `upload not found: ${op.uuid}`);
    }

    // Optional Content-Range validation. If present, start must match
    // current received_bytes; otherwise it's a 416.
    const cr = req.headers["content-range"] as string | undefined;
    if (cr) {
      const m = cr.match(/^(\d+)-(\d+)$/);
      if (!m) {
        return sendOciError(reply, 400, "BLOB_UPLOAD_INVALID", `bad Content-Range: ${cr}`);
      }
      const start = Number(m[1]);
      if (start !== upload.receivedBytes) {
        reply.header("Range", `0-${Math.max(0, upload.receivedBytes - 1)}`);
        return sendOciError(
          reply,
          416,
          "BLOB_UPLOAD_INVALID",
          `expected next byte at offset ${upload.receivedBytes}, got ${start}`
        );
      }
    }

    const stream = bodyToStream(req.body);
    if (!stream) {
      return sendOciError(reply, 400, "BLOB_UPLOAD_INVALID", "request body missing");
    }
    const { bytesWritten } = await streamWriteBlob(
      ctx.pool,
      upload.contentOid,
      upload.receivedBytes,
      stream
    );
    const newTotal = upload.receivedBytes + bytesWritten;
    await updateRegistryUploadReceived(ctx.queryFn, op.uuid, newTotal);

    return reply
      .status(202)
      .header("Location", `/v2/${op.repo}/blobs/uploads/${op.uuid}`)
      .header("Range", `0-${Math.max(0, newTotal - 1)}`)
      .header("Docker-Upload-UUID", op.uuid)
      .send();
  }

  async function uploadCompleteHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "uploadSession" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "push" }
    ]);
    if (!grant) return reply;
    const q = req.query as Record<string, string | undefined>;
    const expectedDigest = q.digest;
    if (!expectedDigest) {
      return sendOciError(
        reply,
        400,
        "DIGEST_INVALID",
        "PUT upload requires ?digest=<sha256:...>"
      );
    }
    if (!isValidDigest(expectedDigest)) {
      return sendOciError(reply, 400, "DIGEST_INVALID", `not a valid digest: ${expectedDigest}`);
    }

    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const upload = await getRegistryUpload(ctx.queryFn, op.uuid);
    if (!upload || upload.repo !== op.repo) {
      return sendOciError(reply, 404, "BLOB_UPLOAD_UNKNOWN", `upload not found: ${op.uuid}`);
    }

    // Final chunk may ride along on the PUT request body. Append it
    // before computing the digest.
    let finalReceived = upload.receivedBytes;
    const stream = bodyToStream(req.body);
    if (stream) {
      const { bytesWritten } = await streamWriteBlob(
        ctx.pool,
        upload.contentOid,
        upload.receivedBytes,
        stream
      );
      finalReceived = upload.receivedBytes + bytesWritten;
    }

    const { digest, size } = await computeBlobDigest(ctx.pool, upload.contentOid);
    if (size !== finalReceived) {
      // Should never happen if our offset tracking is correct.
      await unlinkBlobOid(ctx.pool, upload.contentOid).catch(() => undefined);
      await deleteRegistryUpload(ctx.queryFn, op.uuid);
      return sendOciError(
        reply,
        500,
        "BLOB_UPLOAD_INVALID",
        `size mismatch: tracked ${finalReceived}, blob is ${size}`
      );
    }
    if (digest !== expectedDigest) {
      await unlinkBlobOid(ctx.pool, upload.contentOid).catch(() => undefined);
      await deleteRegistryUpload(ctx.queryFn, op.uuid);
      return sendOciError(
        reply,
        400,
        "DIGEST_INVALID",
        `uploaded digest ${digest} does not match expected ${expectedDigest}`
      );
    }

    // Idempotent commit: if the same digest already exists, we drop
    // this upload's oid and reuse the existing blob row.
    const existing = await getRegistryBlobMeta(ctx.queryFn, digest);
    if (existing) {
      await unlinkBlobOid(ctx.pool, upload.contentOid).catch(() => undefined);
    } else {
      await insertRegistryBlob(ctx.queryFn, {
        digest,
        mediaType: String(req.headers["content-type"] ?? null) || null,
        sizeBytes: size,
        contentOid: upload.contentOid
      });
    }
    await deleteRegistryUpload(ctx.queryFn, op.uuid);

    return reply
      .status(201)
      .header("Location", `/v2/${op.repo}/blobs/${digest}`)
      .header("Docker-Content-Digest", digest)
      .send();
  }

  async function uploadCancelHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    op: Extract<RegistryOp, { kind: "uploadSession" }>
  ) {
    const grant = requireAuth(req, reply, [
      { type: "repository", name: op.repo, action: "push" }
    ]);
    if (!grant) return reply;
    const ctx = await withPool(reply);
    if (!ctx) return reply;
    const removed = await deleteRegistryUpload(ctx.queryFn, op.uuid);
    if (!removed || removed.repo !== op.repo) {
      return sendOciError(reply, 404, "BLOB_UPLOAD_UNKNOWN", `upload not found: ${op.uuid}`);
    }
    await unlinkBlobOid(ctx.pool, removed.contentOid).catch(() => undefined);
    return reply.status(204).send();
  }
}

/**
 * Parse the OCI pagination query params: `n` (page size) and `last`
 * (cursor — the last item on the previous page). Caps `n` at a sane
 * maximum to prevent a single request from materializing tens of
 * thousands of rows.
 */
export function parsePagination(req: { query: unknown }): {
  limit?: number;
  after?: string;
} {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const rawN = q.n;
  const last = q.last;
  let limit: number | undefined;
  if (rawN !== undefined) {
    const n = Number.parseInt(rawN, 10);
    if (Number.isFinite(n) && n > 0) {
      limit = Math.min(n, 1000);
    }
  }
  return { limit, after: last && last.length > 0 ? last : undefined };
}

/**
 * Coerce a fastify-parsed request body into an async-iterable byte
 * stream. Our content-type parsers leave bodies in three shapes:
 *   - Readable (from the octet-stream passthrough parser)
 *   - Buffer (from the manifest media-type parsers; not a typical body
 *     shape for blob uploads but defensive)
 *   - undefined/null (no body)
 * Returns null when there's nothing to read.
 */
function bodyToStream(body: unknown): AsyncIterable<Buffer> | null {
  if (!body) return null;
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) return null;
    return Readable.from(body);
  }
  // Treat anything that looks like a Readable as a stream.
  if (typeof (body as any)[Symbol.asyncIterator] === "function") {
    return body as AsyncIterable<Buffer>;
  }
  return null;
}

/**
 * Parse a single `Range: bytes=<start>-<end>` header. Returns:
 *   - { start, end } resolved inclusive byte range, when valid
 *   - "invalid" when malformed or out of bounds
 *   - undefined when no Range header was sent
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number
): { start: number; end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return "invalid";
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === "" && endStr === "") return "invalid";
  if (startStr === "") {
    // Suffix range: last N bytes.
    const n = Number.parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }
  const start = Number.parseInt(startStr, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) return "invalid";
  const end = endStr === "" ? size - 1 : Number.parseInt(endStr, 10);
  if (!Number.isFinite(end) || end < start || end >= size) return "invalid";
  return { start, end };
}
