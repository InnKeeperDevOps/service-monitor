---
title: Binding services to agents
nav_order: 6
parent: Install Agent
---

# Binding services to agents

A `MonitoredService` and a Kaiad agent are linked through a **many-to-many
binding**: one service can be observed by several agents at once (HA setups,
multi-cluster deployments where each cluster has its own agent), and one
agent can be the observer for many services. The binding is independent of
the service's other config — you can change the bound agent set without
touching the repo URL, branch, or SSH key.

## When to bind multiple agents to one service

- **High-availability monitoring.** Two agents on separate hosts watch the
  same service. The auto-fix dispatcher picks whichever is online when an
  error fingerprint lands; if both are offline the group flips to
  `missing_auth` (current dispatcher reuses the same status — see the
  [error grouping doc]({% link agent/error-grouping.md %}#lifecycle) for
  the lifecycle).
- **Multi-cluster Kubernetes.** A workload runs in two clusters; each
  cluster has its own [Kaiad operator install]({% link agent/kubernetes.md %})
  and its own `KaiadAgent`. Both bind to the same `MonitoredService`. The
  agents tail their in-cluster pods independently and report under the
  same `serviceId`; error groups dedupe across both clusters by
  fingerprint.
- **Migration windows.** Bind the new agent before unbinding the old one
  to avoid an observability gap.

## When *not* to bind multiple agents

- **Single-host services with no HA need.** One agent is fine. Multi-bind
  doesn't add value and creates ambiguity in `kubectl`-style commands
  ("which agent runs this fix?" — currently: first online).
- **As a redundancy substitute for the agent process itself.** If you need
  the agent to be HA, run the agent under a supervisor (k8s
  Deployment/systemd) — that's the right tool. Multi-bind is for
  observability redundancy across hosts/clusters, not for agent uptime.

## Editing bindings from the panel

Two surfaces, both equivalent:

1. **Agents page → expand a row → Services subsection.** Pick a service
   from the dropdown and click **+ Bind**. Existing bindings appear with
   a Detach button. Best for "this agent should watch these services."
2. **Services page → edit a service → Bound agents fieldset.**
   Multi-select checkboxes for every agent in the tenant. Best for "this
   service is watched by these agents."

Both call the same endpoints under the hood — pick whichever direction
matches your mental model for the action.

## Editing bindings from the API

Per-binding (preferred for one-at-a-time changes; safe to call repeatedly):

```bash
# Bind
curl -fsS -X POST $KAIAD/api/v1/agents/$AGENT_ID/services/$SERVICE_ID \
  -H "Authorization: Bearer $TOKEN"
# {"bound":true,"agentId":"...","serviceId":"..."}

# Unbind
curl -fsS -X DELETE $KAIAD/api/v1/agents/$AGENT_ID/services/$SERVICE_ID \
  -H "Authorization: Bearer $TOKEN"
# 204
```

Bulk replace via `PATCH /api/v1/services/:id` with `agentIds[]`:

```bash
curl -fsS -X PATCH $KAIAD/api/v1/services/$SERVICE_ID \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"agentIds":["agt-1","agt-2"]}'
```

`agentIds` semantics on `PATCH`:

- Provided + non-empty: replace the full set of bindings (delete-not-in,
  insert-missing).
- Provided + `[]`: detach all agents from this service.
- Omitted: bindings are left alone.

## Auto-fix targeting

When a service has multiple bindings and an `app_log_error` lands:

1. The dispatcher reads the bindings list in creation order (oldest first).
2. It picks the first agent whose realtime session is currently connected.
3. If none are connected, the group reports `skipped_no_online_agent` —
   no command is queued, the group stays `open` for the next attempt.

Round-robin and "least-loaded" strategies are tracked as a follow-up; the
current behavior is deliberately simple. If you have a preference for
*which* agent should win on a service that has both an HA pair, bind your
preferred agent first.

## Tenant scoping

Both the agent and the service must live in the session's tenant. A bind
attempt that names an agent or service in another tenant returns 404 (the
API doesn't leak whether the resource exists in another tenant). Same on
detach.

## What deleting an agent does

`DELETE /api/v1/agents/:id` removes the agent and **garbage-collects all
bindings for that agent**. The services it was bound to remain — they
just lose this one binding row. Same for `DELETE /api/v1/services/:id`
on the service side.

## See also

- [HTTP API reference]({% link reference/api.md %}#per-binding-endpoints)
- [Error grouping & auto-fix]({% link agent/error-grouping.md %})
  — what the auto-fix dispatcher does with the chosen agent.
- Plan that introduced this model:
  `docs/superpowers/plans/2026-05-08-multi-agent-service-binding-plan.md`
