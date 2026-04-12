# BUG-API-001: API returns 500 on /me during acceptance tests

**Detected by:** CI acceptance test failure (`AT-API-003 authenticated me: AssertionError: expected 500 to be 200`)
**Severity:** High
**Status:** Resolved

## Summary
The API `/api/v1/me` returned a 500 Internal Server Error during acceptance tests because `tenant_memberships` table did not exist. The `ensureCoreSchema` migration was only triggered lazily when `domainStore` was accessed, but `/api/v1/me` accesses `authStore` without touching `domainStore`.

## Affected plan / definition reference
The API is expected to reliably return a 200 for authenticated requests. The Postgres integration assumes the schema is created on startup.

## Reproduction steps
1. Start `docker compose up -d` with `DATABASE_URL` set to an empty postgres database.
2. Call `curl -H "Authorization: Bearer dev-token" http://localhost:3001/api/v1/me`.
3. Receive `500 Internal Server Error`.

## Root cause
`initDomainStoreFromEnv` triggers `ensureCoreSchema` lazily. When `swapAuthStoreToPostgres` swaps the auth store, the postgres tables don't exist yet unless `domainStore` was hit.

## Fix direction
Call `ensureCoreSchema(pool)` directly inside `swapAuthStoreToPostgres` before swapping the store.