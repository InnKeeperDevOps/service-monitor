---
title: Kaiad
nav_order: 1
---

# Kaiad

**Kaiad** is a **multi-tenant control plane** for operating services you care about: it brings together an **operator-facing web app**, a **HTTP and WebSocket API**, **background workers**, and **customer-managed agents** that run next to real workloads. Together they support **incident detection and deduplication**, **queued remediation and automation**, optional **GitHub App** flows (webhooks, PRs, workflow dispatch), and **remote commands** to agents over a long-lived realtime channel.

This documentation site refers to the platform as **Kaiad** (also the name shown in the admin UI). The same codebase and releases live in the open-source **[kaiad](https://github.com/InnKeeperDevOps/kaiad)** repository on GitHub.

## What Kaiad is for

| You want to… | Kaiad provides… |
|--------------|-----------------|
| See when things go wrong | Log-derived signals, **incidents** with deduplication (fingerprint + cooldown), and a place to triage them in the UI. |
| Automate response | **Workers** that run remediation steps on **Redis-backed queues** (BullMQ), including Git operations when policy allows. |
| Act where the software runs | **Agents** (Go) that connect **outbound** to your Kaiad deployment over **WSS**, then execute shell, Docker, or plan-based steps you send from the platform. |
| Tie identity to GitHub | A **GitHub App** installation per scope, **signed webhooks** into the API, and worker-side use of installation tokens for mutations. |

Kaiad is **not** a generic observability backend (it is not a full replacement for metrics APMs or log SaaS at large scale). It **is** an opinionated **control plane plus agent** model: operators configure tenants, services, agents, and automation; agents and workers carry out the work.

## Architecture (high level)

Operators use the **browser UI** and the **REST API** (`/api/v1`). **Agents** never require a public **inbound** port from the internet for the SaaS path—they **dial out** over **WSS** to the **realtime** endpoint on the API tier. **Workers** share **Redis** with the API for **BullMQ** jobs (remediation, GitHub work, **agent commands**, log ingestion). **Postgres** holds durable tenant and domain data when configured.

{::nomarkdown}
{% include mermaid-architecture.html %}
{:/nomarkdown}

![Kaiad admin SPA dashboard showing tenant overview, active agents, recent incidents, and navigation links to Agents, Services, Incidents, Registry, SSH Keys, Load Balancers, and Settings](/assets/screenshots/dashboard.png)

**Reading the diagram:** GitHub pushes events into the API; workers pull work from Redis, may call GitHub, and coordinate **agent commands** and other jobs through the same control plane stack. The **realtime gateway** (WebSocket path used by agents) may live in the API process or behind a load balancer—see [Realtime gateway]({% link runbooks/realtime-gateway.md %}) for operations detail.

## How a typical flow works

1. An **agent** connects with an **enrollment token**, sends **heartbeats**, and may stream **container logs**; the platform can raise or merge **incidents** based on rules and deduplication.
2. **Workers** dequeue jobs from **Redis**: run remediation jobs, perform **GitHub** actions when allowed, enqueue **agent commands**, and process **log ingestion** jobs.
3. **Operators** use the **SPA** and **API** to configure tenants, review incidents, manage **enrollment tokens**, and inspect **agents**.

For a deeper narrative, see [Getting started]({% link getting-started/index.md %}).

## Main moving parts

| Piece | Role |
|-------|------|
| **Web** (`apps/web`) | React/Vite **admin UI**: auth, settings, incidents, agents, services. |
| **API** (`apps/api`) | **Fastify** HTTP server: REST, auth, webhooks, tenant data; **WebSocket** endpoint for agent sessions. |
| **Workers** (`apps/worker`) | **BullMQ** consumers plus a small **health** HTTP server for orchestration. |
| **Agent** (`apps/agent`) | **Go** binary: outbound **WSS**, Docker socket (typical), command execution. |
| **Postgres** | Durable storage for tenant-scoped configuration and domain objects when `DATABASE_URL` is set. |
| **Redis** | Queues and coordination for workers and realtime-related paths. |

Ports commonly used in development: **3001** (API), **4173** or preview port (web), **9090** (worker health). Production hostnames and TLS are yours to configure.

## Security and network posture

Agents are **egress-only** toward Kaiad for the SaaS path; customers firewall **outbound HTTPS/WSS** to your hostname instead of opening the agent to the public internet. See [Security overview]({% link security/index.md %}) and [Agent networking]({% link security/agent-networking.md %}).

## Guides

- [Getting started]({% link getting-started/index.md %}) — mental model, then control plane, GitHub App, and agents.
- [Configure the control plane]({% link getting-started/configure-control-plane.md %}) — environment variables, API/worker processes, Compose reference.
- [GitHub App setup]({% link getting-started/github-app.md %}) — permissions, webhooks, secrets, troubleshooting.
- [Install Agent]({% link agent/install.md %}) — release binaries, systemd, Docker, environment variables.
- [Onboarding a service]({% link getting-started/onboarding-services.md %}) — wire up a Git repo, author `kaiad.yaml`, ship the first build.

## Reference

- [Reference overview]({% link reference/index.md %}) — OpenAPI location, queues, correlation headers, env summaries.
- [API reference]({% link reference/api.md %}) — HTTP surface area.
- [`kaiad.yaml` reference]({% link reference/pipeline.md %}) — full pipeline schema, build modes, environments, validation rules.
- [Pipeline variables]({% link reference/pipeline-variables.md %}) — `{var}` interpolation: system vars, dependency vars, naming rules.
- [Built-in OCI registry]({% link reference/registry.md %}) — Kaiad's native registry: endpoints, auth, storage, GC.
- [`KaiadAgent` CRD reference]({% link reference/kaiad-agent-crd.md %}) — the Kubernetes custom resource the operator reconciles into an agent + scoped RBAC.

## Runbooks

- [Runbooks overview]({% link runbooks/index.md %})
- [Redis failure]({% link runbooks/redis-failure.md %})
- [PostgreSQL failure]({% link runbooks/postgres-failure.md %})
- [Realtime gateway]({% link runbooks/realtime-gateway.md %})
- [Worker failure]({% link runbooks/worker-failure.md %})

## Security

- [Security overview]({% link security/index.md %})
- [Agent networking]({% link security/agent-networking.md %})
