# BUG-UI-001: SSH Keys Add Form API Payload Validation Failure

**Detected by:** Dev panel UI verification with cursor-ide-browser tool
**Severity:** High
**Status:** Resolved

## Summary
When submitting the Add SSH Key form in the UI, the API returns a validation error because `type` was passed as `keyType` and `privateKey` was passed as `privateKeyPem`. The `createSshKeyRequestSchema` expects `type` and `privateKey`.

## Affected plan / definition reference
`packages/contracts/src/http.ts`: `createSshKeyRequestSchema` requires `type` and `privateKey`. `docs/superpowers/plans/2026-04-12-ssh-keys-plan.md` outlines the schema matching the endpoint.

## Reproduction steps
1. Log into the dev panel.
2. Navigate to `SSH Keys`.
3. Click "Add Key".
4. Fill in the Name and Private Key fields.
5. Click "Create Key".
6. Observe the form doesn't close and a 400 Bad Request is returned by the API (previously 500 when Fastify error handler swallowed Zod errors).

## Root cause
The React component `SshKeysPage.tsx` passed `{ name: form.name, keyType: form.keyType, privateKeyPem: form.privateKey }` to `api.createSshKey()`, which mismatched the `CreateSshKeyRequest` type signature that expected `{ name, type, privateKey }`.

## Resolution
Updated `apps/web/src/features/ssh-keys/SshKeysPage.tsx` to correctly map form state to the `CreateSshKeyRequest` object when calling `api.createSshKey()`. The dev Docker image was rebuilt to reflect the fixed static bundle, and the UI test successfully passed.
