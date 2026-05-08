---
title: API Credentials
nav_order: 1
---

# API Credentials

API credentials are **long-lived bearer tokens** for machine
integrations. They are how the [Kaiad agent operator]({% link agent/kubernetes.md %})
mints enrollment tokens at install time, and how any other automation
that needs to call the Kaiad API on its own schedule (CI jobs, custom
webhook gateways, scripted tenant administration) authenticates without
holding a human session.

## How they differ from other tokens

| Kind | Lifetime | Purpose | Created via |
|---|---|---|---|
| **Session token** | 24h | A signed-in human's bearer for the panel and direct API calls. | `POST /api/v1/auth/login` |
| **Enrollment token** | minutes – days (caller picks TTL) | Single-use bootstrap for a Kaiad agent on first connect. | `POST /api/v1/agents/enrollment-tokens` |
| **API credential** | until revoked | Machine integration; carries explicit scopes. | `POST /api/v1/admin/api-credentials` (this page) |

A user session implicitly holds every scope (an owner can do anything an
api credential can). API credentials hold *only* the scopes named at
creation time — nothing more.

## Available scopes

| Scope | Unlocks |
|---|---|
| `enrollment-tokens.create` | `POST /api/v1/agents/enrollment-tokens` — mint short-TTL enrollment tokens for new agents. |
| `agents.read` | `GET /api/v1/agents`, `GET /api/v1/agents/:id` — for status polling. |

The scope set is intentionally narrow and grows by deliberate addition.
If you need an action a machine integration can't perform today, open an
issue rather than minting a session and storing it as a service account
— sessions are not designed for long-lived storage and they expire.

## Mint a credential

Owner or admin session required.

```bash
curl -fsS -X POST $KAIAD_BASE_URL/api/v1/admin/api-credentials \
  -H "Authorization: Bearer $YOUR_OWNER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"k8s-operator","scopes":["enrollment-tokens.create"]}'
```

Sample response:

```json
{
  "id": "apicred-c7e8d563-f03d-4509-ba11-20e308e56de2",
  "tenantId": "t-...",
  "name": "k8s-operator",
  "scopes": ["enrollment-tokens.create"],
  "createdAt": "2026-05-08T06:09:55Z",
  "createdBy": "u-...",
  "lastUsedAt": null,
  "revokedAt": null,
  "token": "kop_79cd7aab5048fd5e97127212c933f844c108d5427ef0f3c37e1576d8b8252431"
}
```

The `token` field is **shown exactly once**. The server stores only a
SHA-256 hash; if you lose the plaintext you must revoke the credential
and mint a new one.

Tokens are formatted `kop_` + 64 hex chars (the `kop_` prefix is
intentional so a leaked token is recognizable in log scrubbers and
secret-scanning tools).

## Use a credential

Send the token as a regular `Authorization: Bearer` header. The API's
`resolveSession` falls through to the api-credentials store after the
session lookup misses, so any route a credential's scopes permit
accepts it transparently.

```bash
curl -fsS -X POST $KAIAD_BASE_URL/api/v1/agents/enrollment-tokens \
  -H "Authorization: Bearer $KOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ttlSeconds": 300}'
```

## List and revoke

Owner or admin session required for both. The list endpoint **never
returns the plaintext token** — only the metadata.

```bash
curl -fsS $KAIAD_BASE_URL/api/v1/admin/api-credentials \
  -H "Authorization: Bearer $YOUR_OWNER_SESSION_TOKEN"

curl -fsS -X DELETE \
  $KAIAD_BASE_URL/api/v1/admin/api-credentials/apicred-... \
  -H "Authorization: Bearer $YOUR_OWNER_SESSION_TOKEN"
```

Revocation is by setting `revoked_at`, not by deleting the row, so the
audit trail remains intact. A revoked token is rejected by the API
immediately.

## Privilege-escalation gate

API credentials **cannot create or revoke other API credentials**, even
if you grant them every published scope. The admin endpoints
short-circuit on `session.kind === "apiCredential"` and return 403
before consulting scopes. This is deliberate: it means a leaked
machine token cannot be used to mint a fresh one with broader scopes,
extending the blast radius beyond what the original credential could
already do.

If a machine integration needs to bootstrap *another* machine integration,
the answer is a human-in-the-loop step (an admin runs the mint command),
not a programmatic chain.

## Rotation

API credentials never expire automatically. Treat them like any other
long-lived secret:

- **Storage**: in a cluster Secret, a vault, or an environment-variable
  secret managed by your orchestrator. Never check into VCS.
- **Schedule**: rotate on a calendar (every 90 days is reasonable),
  before personnel changes affect who has access to the storage system,
  and immediately on any suspected exposure.
- **Procedure**: mint the new credential first, update the consumer to
  use it, confirm `lastUsedAt` advances, then revoke the old one.
  Never revoke before the new credential is live; you'll take the
  consumer down.

The `lastUsedAt` column on the metadata response is your check that a
rotation succeeded — the new credential should show recent activity,
the old one should stop showing it.

## RBAC and tenant scope

API credentials are **tenant-scoped** — each row belongs to one tenant
and only authenticates that tenant's endpoints. There is no concept of
a cross-tenant operator credential; if you operate multiple Kaiad
tenants, each one mints its own credentials and your integration holds
each one separately.

The `role` of an authenticated api-credential session is pinned to
`operator`. This is *not* an administrative role and won't satisfy the
`role === "owner" | "admin"` checks on admin endpoints. Scopes are the
only authorization signal that flows from the credential.

## See also

- [Install on Kubernetes]({% link agent/kubernetes.md %}) — the
  operator's install flow uses a `enrollment-tokens.create` credential.
- [HTTP API reference]({% link reference/api.md %}#admin-api-credentials)
  — full request/response schemas.
