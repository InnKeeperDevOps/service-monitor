---
title: kaiad.yaml reference
parent: Reference
nav_order: 2
---

# `kaiad.yaml` reference

`kaiad.yaml` lives at the **root of a monitored service's Git
repository**. It describes how Kaiad builds, packages, and deploys the
service. The full schema is enforced by Zod in
**`packages/contracts/src/pipeline.ts`**; this page is the human-readable
version.

For onboarding narrative (panel UI, SSH keys, first build), see
[Onboarding a service]({% link getting-started/onboarding-services.md %}).
For interpolation syntax see
[Pipeline variables]({% link reference/pipeline-variables.md %}).

The stages a single build runs through:

{::nomarkdown}
{% include mermaid-build-pipeline.html %}
{:/nomarkdown}

## Two top-level shapes

A `kaiad.yaml` is either a **single-pipeline** file (one image, one
deployable) or a **multi-pipeline** file (`services:` map — many images
in one repo).

### Single-pipeline

```yaml
version: 1
build:    { … }
runtime:  { … }
ports:    [{ port: 8080 }]
domains:  [{ host: app.example.com, port: 8080, protocol: https }]
```

The MonitoredService referencing this repo leaves **Pipeline Name** blank.

### Multi-pipeline

```yaml
version: 1
services:
  api:
    build:    { … }
    runtime:  { … }
    ports:    [{ port: 8080 }]
  worker:
    build:    { … }
    runtime:  { … }
    dependsOn: [api]
```

Each MonitoredService that points at this repo sets **Pipeline Name** to
one of the keys (`api`, `worker`, …). One repo can back several
MonitoredService records — one per pipeline — each with their own
agents and domain wiring.

{::nomarkdown}
{% include mermaid-multi-pipeline.html %}
{:/nomarkdown}

Field semantics inside an inner pipeline are identical to the
single-pipeline shape; the only difference is that the `version: 1`
declaration is shared and lives at the file root.

## `version: 1` — required

```yaml
version: 1
```

Currently the only supported value. Older or newer values fail parse.

## Build modes (mutually exclusive)

A pipeline produces a runtime image in **one of two ways**. You can use
the `build + artifacts + runtime` trio **or** `dockerfile:` — never both.

### Mode A — `build` / `artifacts` / `runtime`

The default. Kaiad runs a one-shot **build container**, captures named
files into `/artifacts/...`, then layers them onto a runtime image with
crane.

| Field | Type | Required | Default | Notes |
|------|------|----------|---------|-------|
| `build.image` | string | yes | — | Docker image used as the build environment. Anything pullable by the host docker daemon. |
| `build.steps` | string[] | yes | — | Shell commands run sequentially, each via `sh -c`. `set -eu` is applied automatically. |
| `build.env` | map<string,string> | no | `{}` | Extra env vars exposed to all steps. |
| `artifacts` | string[] | no | `[]` | Filenames under `/artifacts/` to capture. Must match the `from:` in `runtime.copy` and `runtime.layers`. |
| `runtime.image` | string | no | `scratch` | Base image for the pushed runtime. |
| `runtime.copy` | array | no | `[]` | Each entry is `{ from: <artifact-name>, to: <abs-path-in-image> }`. |
| `runtime.layers` | string[] | no | `[]` | Tar archives (from `artifacts:`) appended verbatim as filesystem layers. |
| `runtime.command` | string[] | yes (if `runtime` present) | — | Exec-form entrypoint argv (`["node", "/app/server.js"]`). |

**Inside the build container**, the worker bind-mounts:

- `/workspace` — the repo checked out at the build's SHA (read-write).
- `/artifacts` — empty scratch dir. Anything written here that matches
  an entry in `artifacts:` is preserved.

Environment variables automatically set on every step:
`GIT_SHA`, `GIT_BRANCH`, `KAIAD_SERVICE_NAME`.

Example:

```yaml
build:
  image: golang:1.22
  env:
    CGO_ENABLED: "0"
  steps:
    - go build -o /artifacts/server ./cmd/server
    - go test ./...
artifacts:
  - server
runtime:
  image: gcr.io/distroless/static
  copy:
    - from: server
      to: /server
  command: ["/server"]
```

### Mode B — `dockerfile`

Falls back to a host `docker build` and pushes the result. Useful when
upstream tooling already ships a Dockerfile that's hard to reproduce as
build steps.

| Field | Type | Required | Default | Notes |
|------|------|----------|---------|-------|
| `dockerfile.path` | string | no | `Dockerfile` | Relative to repo root. |
| `dockerfile.context` | string | no | `.` | Build context, relative to repo root. |
| `dockerfile.args` | map<string,string> | no | `{}` | `--build-arg` map. |
| `dockerfile.target` | string | no | — | `--target` stage for multi-stage builds. |

Example:

```yaml
dockerfile:
  path: docker/Dockerfile
  context: .
  args:
    NODE_ENV: production
  target: runtime
```

**Cannot coexist with `build`, `artifacts`, or `runtime`.** The schema
rejects pipelines that try to set both.

## Deployment fields

These apply to whichever build mode you pick.

### `kind`

```yaml
kind: deployable    # default
# or:
kind: supporting
```

- **`deployable`** — every successful build dispatches a redeploy to
  bound agents. The default.
- **`supporting`** — the build produces an artifact (typically a base
  image other services use) but is **never deployed to agents** even
  when bound. Use this for "library" repos like a hardened PHP base
  image referenced by app builds via `dependsOn:`.

### `dependsOn`

```yaml
dependsOn:
  - php-image
  - shared-config
```

Names of **other MonitoredServices in the same tenant** that must have
a successful build before this one can run. Effects:

- Build worker waits for each dep's latest successful build and
  exposes its outputs as
  [variables]({% link reference/pipeline-variables.md %}#dependency-variables)
  (`{php_image_version}`, etc.).
- A successful build of this service triggers downstream rebuilds of
  any service that lists **this** name in its `dependsOn:`.
- The build worker's JWT scope includes `pull` access on each kaiad-
  hosted dep so crane can fetch dep images during runtime assembly.

Failures cascade: if a dep has no successful build yet, this build
fails with `dependency "<name>" has no successful build yet`.

{::nomarkdown}
{% include mermaid-depends-on.html %}
{:/nomarkdown}

### `ports`

```yaml
ports:
  - port: 8080
    name: http        # optional, human-readable
    protocol: TCP     # TCP (default) | UDP
  - port: 9090
    name: metrics
```

Declares which TCP/UDP ports the runtime image exposes. Required when
`domains:` references any port. Used by the agent to publish the
service.

### `instances`

```yaml
instances: 3   # default 1; 0 is allowed (scaled-to-zero)
```

Default replica count when no environment-specific override applies.

### `domains`

```yaml
domains:
  - host: app.example.com
    port: 8080
    protocol: https   # https = TLS terminated at ingress
  - host: '*.preview.example.com'   # wildcards allowed
    port: 8080
    protocol: https
```

- `port` **must** appear in `ports:`.
- `protocol: https` means the ingress terminates TLS; the container
  itself speaks plain HTTP on the declared port.
- `protocol: http` disables TLS termination — typical for
  cluster-internal hostnames.

Wildcard hosts (`*.foo.com`) are allowed; the ingress backend has to
support them (most do).

### `loadBalancer`

How the agent should publish the service. Defaults to `{type: none}`
(cluster-internal). Per-environment overrides can change this.

```yaml
# k8s: provider-managed LoadBalancer (AWS/GCP/Azure).
loadBalancer:
  type: k8s
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
```

```yaml
# MetalLB: bare-metal LB controller with optional address pool.
loadBalancer:
  type: metallb
  addressPool: prod-public
```

```yaml
# MetalLB with a PINNED fixed IP (cluster convention: a fixed IP from
# a pool). Renders the Service with annotation
#   metallb.universe.tf/loadBalancerIPs: 192.168.1.228
# loadBalancerIPs accepts a single IP or a comma-separated list, and
# can be combined with addressPool to pin an IP that belongs to a pool.
loadBalancer:
  type: metallb
  addressPool: first-pool       # optional
  loadBalancerIPs: 192.168.1.228
```

```yaml
# ingress-nginx: Service.type=ClusterIP + Ingress resources.
loadBalancer:
  type: nginx
  ingressClass: nginx     # default
  tlsSecret: app-tls      # optional pre-existing Secret
```

```yaml
# Cluster-internal only.
loadBalancer: { type: none }
```

### `namespace`

```yaml
namespace: my-app
```

Kubernetes namespace (or Docker project name when the agent is
docker-based). Lowercase k8s-style: alphanumeric + hyphens, max 63
chars.

When unset, the agent picks:
- k8s runtime: the agent's own pod namespace.
- docker runtime: the literal `kaiad`.

### `environments`

Per-environment overrides for `instances`, `domains`, `loadBalancer`,
and `namespace`. Top-level values are the defaults; any field omitted
inside an environment falls back to the top-level value.

```yaml
instances: 1
domains:
  - host: dev.app.example.com
    port: 8080
    protocol: https
loadBalancer: { type: nginx }

environments:
  staging:
    instances: 2
    domains:
      - host: staging.app.example.com
        port: 8080
        protocol: https
  production:
    instances: 5
    domains:
      - host: app.example.com
        port: 8080
        protocol: https
    loadBalancer:
      type: nginx
      tlsSecret: prod-app-tls
    namespace: prod
```

Environment names follow the same shape as namespaces
(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`). They're matched against the
agent's configured environment label at deploy time.

## Validation rules enforced at parse time

The Zod schema rejects yaml violating any of:

- `version != 1`
- `dockerfile:` together with `build:`, `runtime:`, or `artifacts:`.
- `runtime.copy.from` or `runtime.layers` entry that isn't in `artifacts:`.
- `domains` without any matching entry in `ports:`.
- `domains[*].port` that isn't declared in `ports:`.
- An environment name that doesn't match the k8s label shape.
- An artifact / runtime.copy.to path containing `..` or starting with `/`
  (for artifacts) — defense against malicious yaml.

The build worker fails fast with a human-readable error on any of
these.

## Real-world examples

### Node.js single-pipeline

```yaml
version: 1

build:
  image: node:22
  steps:
    - npm ci --no-audit --no-fund
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

domains:
  - host: api.example.com
    port: 3000
    protocol: https
```

### Spring Boot fat JAR

```yaml
version: 1

build:
  image: maven:3.9-eclipse-temurin-17
  steps:
    - mvn -B -DskipTests package
    - cp target/*.jar /artifacts/app.jar

artifacts:
  - app.jar

runtime:
  image: eclipse-temurin:17-jre
  copy:
    - from: app.jar
      to: /app/app.jar
  command:
    - java
    - -XX:MaxRAMPercentage=75
    - -jar
    - /app/app.jar

ports:
  - port: 8080
    name: http
```

### Supporting base image + app

`php-image` is a `kind: supporting` build that produces a hardened PHP
runtime. `site-php` depends on it and uses
[variables]({% link reference/pipeline-variables.md %}#dependency-variables)
to reference the latest build.

`php-image/kaiad.yaml`:

```yaml
version: 1
kind: supporting
dockerfile:
  path: Dockerfile
```

`site-php/kaiad.yaml`:

```yaml
version: 1
dependsOn: [php-image]

build:
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
  steps:
    - composer install --no-dev --no-interaction
    - tar -cf /artifacts/code.tar -C . .

artifacts:
  - code.tar

runtime:
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
  layers: [code.tar]
  command: ["php-fpm", "--nodaemonize"]

ports:
  - port: 9000
    name: fastcgi
```

Notice `{kaiad_registry_host}` and `{php_image_version}` — see
[variables]({% link reference/pipeline-variables.md %}) for the full
list.

### Multi-pipeline (php + nginx in one repo)

```yaml
version: 1
services:
  php:
    build:
      image: composer:2
      steps:
        - composer install --no-dev
        - cp -r vendor /artifacts/vendor
        - cp -r src /artifacts/src
    artifacts: [vendor, src]
    runtime:
      image: php:8.3-fpm-alpine
      copy:
        - { from: vendor, to: /var/www/vendor }
        - { from: src,    to: /var/www/src }
      command: ["php-fpm", "--nodaemonize"]
    ports: [{ port: 9000, name: fastcgi }]

  nginx:
    dockerfile:
      path: nginx/Dockerfile
    ports: [{ port: 80, name: http }]
    domains:
      - host: app.example.com
        port: 80
        protocol: https
    dependsOn: [php]
```

Two MonitoredService records reference this repo — one with **Pipeline
Name** `php`, the other `nginx`. Each can be bound to different agents.

## See also

- [Pipeline variables]({% link reference/pipeline-variables.md %}) —
  interpolation syntax and the available variables.
- [Built-in registry]({% link reference/registry.md %}) — what happens
  to the image after a build succeeds.
- [Onboarding a service]({% link getting-started/onboarding-services.md %}) —
  end-to-end walkthrough.
