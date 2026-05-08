---
title: Error grouping & auto-fix
nav_order: 5
parent: Install Agent
---

# Error grouping & auto-fix dispatch

Kaiad watches the log stream from each enrolled agent for error-level
lines, normalizes them into deduplicated **error groups**, and (when
the service has the credentials and is eligible) dispatches an
**auto-fix** run that clones the repo, runs the configured plan
executor (`cursor` or `claude`) against the failing context, commits
any changes, and pushes them back. This page covers the full loop:
what you see, how groups are formed, when and why a fix is dispatched,
and the lifecycle states a group moves through.

## In the panel

The Agents page shows an **Error Groups** section per agent. Each row
is one error group with:

- **Status badge** (see [Lifecycle](#lifecycle) below).
- **Sample message** — one representative line; the full deduplicated
  set lives behind it.
- **First / last seen** timestamps and an event count.
- **Service** the group originated from.

A live WebSocket subscription updates the section in place as new
groups appear and existing groups change status.

## How groups are formed

Each `app_log_error` frame the agent emits carries:

- `agentId`, `serviceId`, `message`, `contextLines` (preceding lines
  for context), and `ts`.
- The agent decides what counts as an error-level line; the API
  trusts the classification.

The API normalizes the message before fingerprinting. The
implementation lives in `apps/api/src/errorGrouping.ts:13` and strips:

| Pattern | Replacement |
|---|---|
| ISO/RFC3339 timestamps | `<TS>` |
| `HH:MM:SS` times | `<TIME>` |
| UUIDs | `<UUID>` |
| IPv4 addresses (with optional `:port`) | `<IP>` |
| Long hex tokens (≥8 chars) | `<HEX>` |
| Quoted strings (`"…"` and `'…'`) | `"<STR>"` / `'<STR>'` |
| `path/file.ext:42[:7]` line refs | `path/file.ext:<LINE>` |
| Bare numbers ≥3 digits | `<N>` |

Two errors with the same shape but different request ids therefore
collide into the same group. The fingerprint is
`sha1(serviceId || ' ' || normalizedMessage)`, truncated to 16 hex
chars. This is intentionally noisy on the side of grouping: identical
exception classes from different code paths *may* collide. The
`contextLines` array attached to the group is what disambiguates in the
UI (and the auto-fix prompt) when collisions happen.

## When auto-fix dispatches

On every `app_log_error` the API:

1. **Skips obvious user-input errors.**
   `isProbablyUserInputError` matches conservative patterns
   (`HTTP 4xx`, `bad request`, `unauthorized`, `forbidden`, `not
   found`, `validation error/failed`, `invalid input/payload/json/body`,
   `missing required`, `unprocessable entity`, `schema validation`,
   `zod error`). When it matches, the line is **not** turned into an
   error group at all — there's nothing to auto-fix in user input.
2. **Upserts the group.** Either creates a new one or bumps the event
   count and last-seen timestamp on an existing fingerprint.
3. **Calls the dispatcher** (`apps/api/src/autoFixDispatcher.ts`).
   The dispatcher returns one of these outcomes:

| Outcome | Meaning |
|---|---|
| `dispatched` | A `run_fix_plan` realtime command was queued for the agent and the group flipped to `fixing`. |
| `skipped_paused` | Group status is `paused`; the dispatcher does nothing. |
| `skipped_already_fixing` | An earlier fix is in flight; we don't pile on. |
| `skipped_missing_auth` | The service has no SSH key or the key material can't be loaded. Group flips to `missing_auth`. |

When dispatched, the agent receives a `run_fix_plan` command containing:

- `errorGroupId`, `errorMessage`, `normalizedMessage`, `fingerprint`
- `contextLines` (the buffered context from the agent's log shipper)
- `gitRepoUrl` and `branch` from the service record
- `sshKeyType` and `sshKeyValue` (resolved from the service's
  `sshKeyId`)

The agent clones the repo into a temp workspace, invokes the
configured plan executor, commits any resulting diff, and pushes to
the service's branch. The whole flow is logged to the agent's stdout
and surfaced as an `agent_command_status` event back to the panel.

## Lifecycle

| Status | Set by | Meaning |
|---|---|---|
| `open` | API on first sighting / when a previous fix fails | The group is eligible for auto-fix on the next matching error. |
| `fixing` | Dispatcher when it queues `run_fix_plan` | A fix is in flight. New occurrences of this fingerprint are recorded but not re-dispatched. |
| `fixed` | API when the fix command reports `completed` | The dispatcher has confirmed the fix landed. The group remains visible in the UI; if the same fingerprint reappears, it flips back to `open` automatically. |
| `paused` | (currently UI-only; see [Pausing](#pausing-a-group) below) | Auto-fix is disabled for this group; new errors still update the count. |
| `missing_auth` | Dispatcher when SSH key lookup fails | The group cannot be auto-fixed until the service is given an SSH key. Re-evaluated on the next matching error. |

## API endpoints

All three list endpoints accept any authenticated session:

```
GET /api/v1/error-groups
GET /api/v1/agents/:agentId/error-groups
GET /api/v1/services/:id/error-groups
```

Response shape: `{ "groups": ErrorGroup[] }` — see
`packages/contracts/src/realtime.ts` for the full schema.

There is **no REST endpoint to set group status** today. The
dispatcher mutates `fixing`, `fixed`, and `missing_auth` internally;
`open` is the default. If you need to manually mark a group `paused`,
do it via the panel (the UI exposes a status toggle that calls an
internal handler — flagged as a gap to formalize).

## Pausing a group

The `paused` status exists as a kill-switch for "I know about this
error and I don't want auto-fix to run on it" cases — for example,
errors caused by an external dependency that you don't own. Today this
is set via the panel's group menu; it is not yet exposed as a REST
endpoint. If you find yourself wanting programmatic control, that's a
real gap — file an issue.

## Realtime events

When a group is created or its status changes the API broadcasts a
`error_group_updated` UI telemetry event over the realtime channel to
every panel session in the tenant. Schema:

```json
{
  "type": "error_group_updated",
  "group": { "id": "...", "status": "fixing", ... }
}
```

The Agents page subscribes via `useTelemetryStream` and patches the
section in place, so a fix that lands within seconds of an error
appears as a single status flip rather than a re-fetch.

## Privacy and data flow

What leaves the host:

- Lines the agent classifies as error-level (the `app_log_error`
  frame body).
- Up to `SM_LOGSHIP_BUFFER` (default 50) preceding lines as
  `contextLines` for the same service.

What stays on the agent host:

- The raw log file. The shipper buffers lines in memory, not on disk.
- Anything the agent didn't classify as error-level.

What's stored on the API side:

- Per-tenant: the error group rows (fingerprint, normalized message,
  sample message, context lines).
- Per-tenant: any auto-fix dispatch metadata (commit SHAs from
  successful fixes).

There is no cross-tenant aggregation. Error groups never travel
beyond the tenant that owns the service the error came from.

## See also

- [Agent runtimes]({% link agent/runtimes.md %}) — `SM_LOGSHIP_BUFFER`
  and how the agent decides what's an error-level line.
- [HTTP API reference]({% link reference/api.md %}#error-groups) —
  request/response schemas.
