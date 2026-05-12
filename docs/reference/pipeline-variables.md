---
title: Pipeline variables
parent: Reference
nav_order: 3
---

# Pipeline variables

Strings inside `kaiad.yaml` may contain **brace-delimited variables**
that the build worker substitutes before each build runs. Substitution
covers every string field — `build.image`, `build.steps`,
`runtime.image`, `runtime.command`, `dockerfile.args`, etc. — and
applies whether or not the pipeline has any `dependsOn` entries.

Source: **`apps/worker/src/builddeps.ts`**.

## Syntax

```yaml
build:
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
```

Variables are wrapped in single braces and contain only lowercase
letters, digits, and underscores. Unknown variables are **left intact**
in the rendered string and the build fails with:

```
unresolved template variable(s) in kaiad.yaml: {foo} {bar}
available: {kaiad_registry_host} {kaiad_registry_internal} …
```

That lets you spot template typos immediately rather than shipping a
broken image ref to `docker pull`.

## System variables

Always available. Sourced from the build worker's environment
(`KAIAD_REGISTRY_HOST`, `KAIAD_REGISTRY_INTERNAL` — set in
`env/<env>/docker-compose.yml`).

| Variable | Value | Use it for |
|---------|-------|-----------|
| `{kaiad_registry_host}` | External registry hostname (e.g. `panel.kaiad.dev`). | The image ref recorded in build rows and pulled by agents. |
| `{kaiad_registry_internal}` | Loopback hostname the worker uses for in-container pushes (e.g. `127.0.0.1:8091`). | Rarely used in `kaiad.yaml`; useful for diagnostic scripts that need to reach the registry from inside the kaiad container. |

Example:

```yaml
# Old, hostname hard-coded — works but bakes panel.kaiad.dev into the repo.
build:
  image: panel.kaiad.dev/php-image:cd121a7929a4...

# Better — portable across dev / staging / prod.
build:
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
```

## Dependency variables

For every entry in `dependsOn:`, the worker resolves the latest
successful build of that service (tenant-scoped, by service name) and
exposes the following variables. The placeholder `<dep>` is the dep's
service name with hyphens turned into underscores (`php-image` →
`php_image`).

| Variable | Value | Notes |
|---------|-------|------|
| `{<dep>_version}` | Full git SHA of the dep's latest successful build. | This is what the dep was actually pushed under — `<registry>/<dep>:{<dep>_version}` resolves to a tag that exists. |
| `{<dep>_short_version}` | 12-char prefix of the full SHA. | For display / log lines / labels where the full SHA is unwieldy. |
| `{<dep>_git_sha}` | Same as `{<dep>_version}` — full SHA. | Alias for readability. |
| `{<dep>_build_id}` | UUID of the build row that produced the dep. | Useful only for audit / debugging — not used in image refs. |
| `{<dep>_image_ref}` | Full image reference incl. tag (e.g. `panel.kaiad.dev/php-image:cd121a7929a4…`). | Only set when the dep build produced an image (most do). |
| `{<dep>_image}` | Image stem (no tag). Same as `{<dep>_image_ref}` with the `:<sha>` stripped. | For ergonomics: `{php_image_image}:{php_image_short_version}` is equivalent to `{php_image_image_ref}` but easier to read at a glance. |

Example with `dependsOn: [php-image, shared-config]`:

```
{php_image_version}        → cd121a7929a4b2219fbc37644a29c14533288c4c
{php_image_short_version}  → cd121a7929a4
{php_image_image_ref}      → panel.kaiad.dev/php-image:cd121a7929a4…
{php_image_image}          → panel.kaiad.dev/php-image
{shared_config_version}    → 9cc57d29c5112e4df5f1128cf31bcaa2c929264b
{shared_config_short_version} → 9cc57d29c511
```

If a dep has **no successful build yet**, the build fails before
substitution runs:

```
dependency "php-image" has no successful build yet —
trigger or wait for its build first
```

## Auto-set container env vars (not template vars)

Don't confuse template variables (`{foo}` rewritten in the yaml) with
**environment variables exposed inside the build container**. The
build worker also sets these on every build container, accessible from
your `steps:` via `$VAR` shell syntax:

| Env var | Value |
|---------|-------|
| `GIT_SHA` | Full SHA of the commit being built. |
| `GIT_BRANCH` | The branch this build was triggered on. |
| `KAIAD_SERVICE_NAME` | This service's MonitoredService name. |

Plus anything you set under `build.env:`.

So a step can do:

```yaml
build:
  steps:
    - echo "building ${KAIAD_SERVICE_NAME} @ ${GIT_SHA}"
    - go build -ldflags "-X main.gitSha=${GIT_SHA}" -o /artifacts/server
```

These are NOT available for `{var}` template substitution in the yaml —
they live inside the container, not the parsed pipeline.

## Where substitution does NOT apply

- **`environments.<name>` keys** — the map keys (environment names) are
  validated against a strict regex before substitution would have a
  chance to run.
- **`pipelineName` values on MonitoredService** — that's a panel /
  database field, not part of the yaml.
- **Cross-pipeline references inside a multi-pipeline file** — each
  inner pipeline gets its own substitution pass with the same vars.
  There's no syntax for one pipeline to reference another's sub-fields.

## Naming rules

Variable names must match `^[a-z0-9_]+$` (case-insensitive in the
matcher, but the system / dep vars are emitted lowercase). Service
names with hyphens are mapped to underscores in the variable name:

```
php-image    → {php_image_version}
shared.lib   → {shared_lib_version}   (any non-[a-z0-9_] char → _)
WorkerCore   → {workercore_version}   (lowercased)
```

The mapping is `name.toLowerCase().replace(/[^a-z0-9_]/g, "_")`.

## End-to-end example

A repo where the runtime image is built on top of a sibling
`php-image` service and tagged with the right SHA:

```yaml
version: 1
dependsOn: [php-image]

build:
  # Use the latest hardened PHP base from our registry.
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
  steps:
    - composer install --no-dev --no-interaction
    - tar -cf /artifacts/code.tar -C . .

artifacts:
  - code.tar

runtime:
  # Same base — composer'd code is layered on top.
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
  layers: [code.tar]
  command: ["php-fpm", "--nodaemonize"]

ports: [{ port: 9000, name: fastcgi }]
```

A successful build of `php-image` will automatically trigger a rebuild
here, so the runtime image always tracks the latest PHP base.

## See also

- [`kaiad.yaml` reference]({% link reference/pipeline.md %}) — every
  field, every option.
- [Onboarding a service]({% link getting-started/onboarding-services.md %}) —
  step-by-step setup.
