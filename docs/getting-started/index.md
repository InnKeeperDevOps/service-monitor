---
title: Getting started
nav_order: 6
has_children: true
---

# Getting started

Kaiad is a **multi-tenant SaaS control plane**: your team operates the platform in your environment, while **customer agents** run beside their workloads (typically Docker-based services), stream logs for error detection, and execute remediation you define. The plane **deduplicates incidents** (fingerprint + cooldown), **queues remediation and automation** jobs, and ties everything to **tenants**, **services**, and **GitHub** installations when you use the GitHub App path.

## What you are operating

| Layer | Role |
|--------|------|
| **Admin SPA** | Operators use the browser UI for configuration, incidents, agents, and services. |
| **API + realtime** | HTTP API for auth, settings, services, incidents, agents, GitHub metadata; **WebSocket** endpoint for long-lived agent sessions. |
| **Agents** | Connect **outbound** (WSS) to the control plane—no inbound firewall holes for agents. |
| **Workers** | Consume **BullMQ** queues on **Redis**: remediation runs, GitHub mutations, agent commands, log ingestion. |
| **Postgres** | Durable tenant and domain data when configured; otherwise dev-oriented in-memory stores may apply. |
| **Redis** | Job queues and realtime coordination (e.g. pending agent commands). |

Progressive disclosure: start here for the mental model, then [configure the control plane]({% link getting-started/configure-control-plane.md %}), [wire the GitHub App]({% link getting-started/github-app.md %}), and [install agents]({% link agent/install.md %}) where workloads run.

## Data and control flow (high level)

1. **Agents** send heartbeats and log lines over the **WSS** channel; the platform evaluates **error-level** logs, applies **deduplication**, and opens or updates **incidents** as configured.
2. **Workers** pick up jobs from **BullMQ** to run remediation tasks, call **GitHub** when policy allows, and dispatch **agent commands** through the realtime tier.
3. **Operators** use the SPA and **REST API** under `/api/v1` for day-2 configuration and incident handling.

## Next steps

- [Configure the control plane]({% link getting-started/configure-control-plane.md %}) — env vars, processes, Compose reference.
- [GitHub App setup]({% link getting-started/github-app.md %}) — permissions, installation, webhooks, allowlists.
- [Install Agent]({% link agent/install.md %}) — binary or container, `SM_REALTIME_URL`, systemd unit.
- [Onboarding a service]({% link getting-started/onboarding-services.md %}) — add a Git repo, write `kaiad.yaml`, watch the first build, deploy to bound agents.

For HTTP/API details, see [API reference]({% link reference/api.md %}) and the [Reference]({% link reference/index.md %}) section. For the build pipeline and the built-in OCI registry, jump straight to the [`kaiad.yaml` reference]({% link reference/pipeline.md %}) and [registry reference]({% link reference/registry.md %}).
