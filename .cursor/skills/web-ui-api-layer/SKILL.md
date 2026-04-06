---
name: web-ui-api-layer
description: >-
  Implements service-monitor web features so React UI talks to the backend through hooks and
  shared @sm/contracts types, not direct fetch/api usage from components. Use when adding or
  changing settings pages, forms that POST JSON to the API, or when refactoring components that
  call api.ts inline.
---

# Web UI / API layering (service-monitor)

## Goal

Presentation (`.tsx`) drives UX; **hooks and helpers** own loading, merging, validation, and errors. [`apps/web/src/lib/api.ts`](apps/web/src/lib/api.ts) stays thin transport.

## Checklist for a new settings-style feature

1. **Contract** — If the request/response shape is shared with the server, add or reuse types and Zod schemas in `@sm/contracts`.
2. **API client** — Add or tighten methods on `api` in [`api.ts`](apps/web/src/lib/api.ts) (correct `GET` behavior, e.g. 404 vs error for optional rows).
3. **Merge + validate** — For full-document `POST`s, add a pure `merge*Payload(sessionId, previous, patch)` plus optional `*Schema.safeParse` before save.
4. **Hook** — `use*` hook: `data`, `loading`, `error`, `isSaving`, `reload`, `savePatch`, `clearError`; use a ref for latest `data` if saves merge against current row.
5. **UI** — Form components receive props from the parent that holds the hook (or a single child may call the hook if isolated); no `api.update*` in JSX handlers except inside the hook.
6. **Tests** — Unit-test merge helpers; integration-test critical flows with mocked `api` (wait for async load before interacting with controlled fields).

## Anti-patterns

- `api.getSettings().then(setX)` inside a component `useEffect` for something that should be reusable.
- Partial `POST` bodies when the API expects a full document—always merge first.
