---
title: Onboarding a service
parent: Getting started
nav_order: 3
---

# Onboarding a service

This page walks an operator from "I have a Git repository" to "Kaiad is
building it on every push and deploying the result to my agents." It
assumes the control plane is already running and at least one agent is
enrolled. If neither is true, complete those steps first:

- [Configure the control plane]({% link getting-started/configure-control-plane.md %})
- [Install Agent]({% link agent/install.md %})

## What you'll do

1. Add an SSH key Kaiad can use to clone the repo.
2. Add the service in the panel, pointing it at the repo and at least
   one agent.
3. Write a `kaiad.yaml` at the repo root.
4. Trigger a build, watch the log, and verify the image lands in the
   built-in registry.
5. (Optional) Configure domains / load balancers so the running service
   is reachable.

The full path from `git push` to a running container looks like this:

{::nomarkdown}
{% include mermaid-service-lifecycle.html %}
{:/nomarkdown}

## 1. SSH key

Kaiad clones each build's source over SSH. The key lives in the panel's
**SSH Keys** page and is referenced by name on the service.

- **Public key** goes on GitHub / GitLab / your forge as a deploy key
  with read access to the repo.
- **Private key** is pasted into the panel, AES-256-GCM-encrypted with
  the platform's `KAIAD_ENCRYPTION_KEY`, and persisted in Postgres.

For organisation-wide setups, a single deploy-key-style account often
backs many services. For tightly-scoped access, generate one keypair
per repo.

![Panel SSH Keys page showing a list of keys with their names, types, and creation dates, and a form to add a new key with name, type (uploaded vs local-path), and private-key fields](/assets/screenshots/ssh-keys.png)

If you've configured the **GitHub App** path
([`getting-started/github-app.md`]({% link getting-started/github-app.md %})),
public repos can sometimes be cloned without an SSH key. Most operators
still set one — auto-fix mutations need write access through the App or
the key.

## 2. Add the service in the panel

In the **Services** page, click **Add Service**. Fields:

| Field | What to put |
|------|-------------|
| **Name** | Lowercase k8s-style label. Becomes part of the pushed image ref (`<registry>/<name>:<sha>`) and is what other services reference in `dependsOn`. |
| **Git Repository URL** | `git@github.com:org/repo.git` (recommended) or the HTTPS form for public repos. |
| **SSH Key** | The key you added in step 1. Required when the URL is SSH. |
| **Branch** | The branch Kaiad polls for pushes. Typically `main`. |
| **Docker Image** | Legacy field — leave blank when using `kaiad.yaml`. |
| **Compose Path** | Legacy field — leave blank when using `kaiad.yaml`. |
| **Pipeline Name** | **Required** when the repo's `kaiad.yaml` is multi-pipeline (`services: { … }`). Leave blank for the single-pipeline form. |
| **Bound agents** | One or more enrolled agents that will run the deployable. Many-to-many: the same agent can host multiple services and a service can be deployed to multiple agents (HA / multi-cluster). |

The service is created immediately. You can edit any field later
without losing builds.

![Add Service form open on the Services page, showing Name, Git Repository URL, SSH Key dropdown, Branch, Docker Image, Compose Path, Pipeline Name, and Bound agents checkboxes](/assets/screenshots/services-add-form.png)

## 3. Write `kaiad.yaml`

`kaiad.yaml` lives **at the repo root** and tells Kaiad how to build,
package, and deploy the service. The full schema is documented in
[the pipeline reference]({% link reference/pipeline.md %}); a minimal
single-pipeline file looks like:

```yaml
version: 1

build:
  image: node:22
  steps:
    - npm ci
    - npm run build
    - cp -r dist /artifacts/dist

artifacts:
  - dist

runtime:
  image: gcr.io/distroless/nodejs22-debian12
  copy:
    - from: dist
      to: /app/dist
  command: ["node", "/app/dist/server.js"]

ports:
  - port: 3000
    name: http
```

Three things to internalise about this shape:

- **`build:`** runs in a one-shot container that mounts `/workspace`
  (your repo at the requested SHA) and `/artifacts` (writable scratch
  space). Anything you write to `/artifacts/...` and list under
  `artifacts:` survives into the runtime image.
- **`runtime:`** is assembled with [crane](https://github.com/google/go-containerregistry/tree/main/cmd/crane).
  Each `runtime.copy` becomes one new image layer on top of `runtime.image`.
  No host `docker build` is involved — the pipeline runs entirely
  inside the kaiad container.
- **`ports:`** declares what the runtime image listens on. `domains:`
  and per-environment overrides reference these ports.

For multi-pipeline repos (e.g. a PHP service paired with an nginx
front-end) use the `services:` form:

```yaml
version: 1
services:
  php:
    build:    { … }
    runtime:  { … }
    ports:    [{ port: 9000, name: fastcgi }]
  nginx:
    runtime:  { … }
    ports:    [{ port: 80, name: http }]
    dependsOn: [php]
```

Each entry under `services:` is its own pipeline. Two **MonitoredService**
records — one per pipeline — point at the same repo with different
**Pipeline Name** values (`php`, `nginx`).

### Build variables

Strings inside `build:`, `runtime:`, and `dockerfile:` may interpolate
brace-delimited variables. The most common ones:

- `{kaiad_registry_host}` — the external registry hostname (so you
  don't hard-code `panel.kaiad.dev`).
- `{<dep>_version}` — full git SHA of a `dependsOn` service's latest
  successful build. With `dependsOn: [php-image]`, you can write
  `image: "{kaiad_registry_host}/php-image:{php_image_version}"`.

A full list lives in [pipeline variables]({% link reference/pipeline-variables.md %}).

## 4. Trigger a build

Three ways to kick off the first build:

- **Manual** — click **Builds** on the service row, then the trigger
  button. Useful for first runs and for re-running a stuck build.
- **Push** — the build worker polls the configured branch; new commits
  fire builds automatically.
- **Dependency** — when a service this one lists in `dependsOn:`
  produces a successful build, Kaiad enqueues a follow-up build here.

The build page streams the log live. Stages you should see:

```
── MANUAL build #<id> <service>@<short-sha> ──
cloning git@github.com:org/repo.git @ <sha>
dep: foo → build <id> sha=<short> image=panel.kaiad.dev/foo:<sha>   (only if dependsOn)
── build stage — image=<build.image> ──
<your build steps' stdout>
captured artifact <name> (<bytes> bytes)
── runtime image (crane assembly) ──
<crane append / push output>
done in <s>s
```

A green build records its pushed image ref in the build row (visible on
the Builds tab and the service detail). The image lives in
**[the built-in registry]({% link reference/registry.md %})** at
`panel.<your-host>/<service-name>:<git-sha>` and at the moving
`:latest` tag.

![Services page with one row expanded, showing the Builds subsection: a table of recent builds with status (success/failed/running), git SHA, duration, and the pushed image ref](/assets/screenshots/services-builds-expanded.png)

## 5. Deployment

Every successful **deployable** build (the default `kind:` value)
dispatches a redeploy to every bound agent. The agent pulls the new
image and rolls it according to its runtime backend:

| Agent runtime | Rollout mechanism |
|---------------|-------------------|
| **Docker** | Pull → stop old container → start new with same name + ports. |
| **Kubernetes** | Patches the agent's `KaiadAgent` CRD; the operator reconciles a Deployment / Service / Ingress. |
| **Shell** | Runs the configured executor's deploy command with the new image ref. |

Bind agents from the Agents page if you didn't pick any at service
creation time. See
[Binding services to agents]({% link agent/binding-services.md %}) for
the full lifecycle.

### Domains and load balancers

`domains:` route an external hostname to one of your declared `ports:`.
Add an entry like:

```yaml
domains:
  - host: app.example.com
    port: 3000
    protocol: https
```

The agent's runtime backend translates this into a k8s Ingress, a
Docker label, or whatever its executor knows how to publish. TLS is
terminated at the ingress; the container itself speaks plain HTTP on
the declared port.

For per-environment overrides (staging on a different host, production
on the canonical one), use the `environments:` map — see the
[pipeline reference]({% link reference/pipeline.md %}#environments).

## Common gotchas

- **`MANIFEST_BLOB_UNKNOWN` at runtime push.** A blob the manifest
  references isn't in the registry. Almost always means the
  `build.image` step crashed before the artifact was produced. Check
  the build log above the runtime stage.
- **`Token lacks pull access to repository:<name>`** during crane
  append. The runtime image's base is a kaiad-hosted ref this build
  isn't authorized to pull. Add the dep to `dependsOn:` so the build
  worker grants pull-scope on it automatically.
- **`kaiad.yaml is multi-pipeline (services: ...); set the service's
  pipelineName to choose one`.** The repo grew a second pipeline since
  you last edited the service. Open the service in the panel and set
  the Pipeline Name to one of the keys under `services:`.
- **`unresolved template variable(s) in kaiad.yaml: {foo}`.** You used
  a `{var}` that wasn't declared — typically a `dependsOn` typo, or a
  reference to `{<dep>_version}` where `<dep>` should be the dep's
  service name with hyphens turned into underscores.
- **`KAIAD_BUILDS_HOST_DIR is not set`.** The compose env that points
  the build worker at the host workspace path is missing. See the
  prod/dev compose files under `env/`.

## Where to go next

- [Pipeline reference]({% link reference/pipeline.md %}) — every field
  in `kaiad.yaml`.
- [Pipeline variables]({% link reference/pipeline-variables.md %}) — the
  full list of interpolation variables.
- [Built-in registry]({% link reference/registry.md %}) — how pull/push
  and image storage work.
- [Binding services to agents]({% link agent/binding-services.md %}) —
  many-to-many semantics and migration patterns.
