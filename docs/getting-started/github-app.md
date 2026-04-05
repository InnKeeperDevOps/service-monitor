---
title: GitHub App setup
parent: Getting started
nav_order: 2
---

# GitHub App setup

The GitHub App lets Kaiad receive **webhooks**, obtain **installation tokens**, and perform **mutations** (PRs, merges, workflow dispatch) subject to your **automation policy**. This page covers permissions, installation flow, secrets, allowlists, and signature troubleshooting.

## Required GitHub permissions

Configure the App with the minimum set needed for your workflows (broad permissions increase blast radius):

| Permission | Typical use |
|------------|-------------|
| **Repository contents** | Read/write files for branches and PRs driven by automation. |
| **Pull requests** | Create/update/merge PRs when policy allows. |
| **Actions** | Trigger or observe workflow runs where you integrate with Actions. |
| **Workflows** | Dispatch or interact with `workflow_dispatch` and related events. |
| **Metadata** | Always required; repository discovery and basic context. |

Subscribe to webhook events your workers actually handle (e.g. `push`, `pull_request`, `workflow_dispatch`, and any ingestion events you enable). Fewer events mean less noise and smaller queues.

## Installation flow (multi-tenant)

1. **Create** the GitHub App under your org or user account and note the **App ID** and **private key** (PEM) for the worker/runtime that calls GitHub’s API.
2. **Install** the App on each **customer organization** (or selected repositories) that should be managed.
3. Record the **installation ID** GitHub assigns to that installation. The platform stores it per tenant via **`POST /api/v1/github/installations`** (authenticated) together with tenant-scoped metadata your product requires.
4. Repeat per tenant: one GitHub installation maps to **one row** in your control plane for that tenant’s automation scope.

Use **`GET /api/v1/github/installations`** to audit what is registered for the current session’s tenant.

## Webhook secret

1. Generate a **long random secret** (e.g. 32+ bytes).
2. Set the same value in:
   - GitHub App **Webhook** settings (secret field).
   - Control plane **`GITHUB_WEBHOOK_SECRET`** for the API process that receives `POST /webhooks/github`.

GitHub signs the raw body with **HMAC-SHA256**; the API expects header **`x-hub-signature-256`** in the form `sha256=<hex>`. A mismatch returns **401** with a webhook signature error—no job is enqueued.

## Allowlist (automation policy)

Before automation runs, **`POST /api/v1/github/policy/check`** evaluates the tenant’s **automation policy** (repos, branches, allowed actions). Configure tenant settings so that:

- Only **trusted repositories** and **branches** appear in the allowlist.
- **Actions** you intend to automate (e.g. merge, dispatch) are explicitly permitted.

This is your **policy gate** between “webhook received” and “mutation enqueued or executed.” Treat allowlist changes as **production changes** and review them in PRs.

## Troubleshooting webhook signatures

| Symptom | What to check |
|---------|----------------|
| **401** `WEBHOOK_SIGNATURE_INVALID` | Secret mismatch between GitHub and `GITHUB_WEBHOOK_SECRET`; whitespace or copy/paste errors; wrong environment (staging vs prod). |
| Signature always wrong | **Body must be raw bytes** the API received—reverse proxies that parse JSON and re-serialize break the signature. Ensure the webhook route uses the **verbatim** body string GitHub signed. |
| Intermittent failures | Multiple API instances with **different** secrets; load balancer hitting wrong stack; old deployment still receiving traffic. |

Rotate the webhook secret by updating GitHub first, then redeploying the API with the new value in a **single coordinated** change.

## Related

- [Configure the control plane]({% link getting-started/configure-control-plane.md %}) — `GITHUB_WEBHOOK_SECRET` and API process.
- [API reference]({% link reference/api.md %}) — GitHub installation and policy endpoints.
- [Security overview]({% link security/index.md %}) — threat model and boundaries.
