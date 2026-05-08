---
title: Agent runtimes
nav_order: 4
parent: Install Agent
---

# Agent runtimes

The Kaiad agent supports four runtime backends. The runtime decides
how the agent executes container operations, runs the auto-fix and plan
executors (`run_cursor_plan`, `run_claude_plan`, `run_fix_plan`), and
reconciles `sync_desired_state` updates from the platform.

You pick the runtime when you generate the enrollment token in the
panel. The choice is just a set of environment variables baked into the
agent's start command — nothing on the platform side changes.

## At a glance

| Runtime | What the agent talks to | Container ops | `run_step` | Auto-fix / plan | Best for |
|---|---|---|---|---|---|
| **Docker** (default) | local Docker daemon socket | yes | yes | yes (containerized when isolation enabled) | VMs, single-host servers, the common case |
| **Podman** | local podman socket | yes (via Docker-compatible API) | yes | yes (no rootful daemon) | RHEL/Fedora hosts, rootless setups |
| **Shell** | the host shell directly | no (`docker_op` is rejected) | yes | yes (uncontained, host PATH) | hosts without Docker; supervisor-managed processes |
| **Kubernetes** | kube API via mounted SA token | not mapped yet (use `run_step` + `kubectl`) | yes | yes (uncontained inside the agent pod) | clusters; managed by the [Kaiad operator]({% link agent/kubernetes.md %}) |

Mechanism: every runtime is selected via `SM_AGENT_RUNTIME_OVERRIDE`,
except Docker (which is the default) and Podman (which uses the Docker
runtime path with `SM_DOCKER_SOCKET` redirected to the podman socket).
The agent log line at startup confirms what's active:

```text
kaiad hello: agent runtime backend=docker
```

---

## Docker (default)

The agent talks to a local Docker daemon over its Unix socket. This is
the original runtime and the most fully-featured.

**What you get**

- Native handling of `docker_op` commands: `start`, `stop`, `build`,
  `run`, `compose_up`, `compose_down`.
- The agent streams logs from existing containers on enrollment so the
  panel sees app log lines immediately.
- Plan executors (`run_cursor_plan`, `run_claude_plan`) and auto-fix
  (`run_fix_plan`) run in disposable workspaces. When container
  isolation is enabled (the agent runs the executor inside a sibling
  container) the workspace is fully sandboxed.

**Prerequisites**

- Docker Engine on the host (any recent version with the v1.41+ API).
- The agent process must be in a group that can write to
  `/var/run/docker.sock`, or run as root. A common pattern is a
  dedicated `kaiad` user added to the `docker` group.

**Environment**

| Variable | Default | Purpose |
|---|---|---|
| `SM_DOCKER_SOCKET` | `/var/run/docker.sock` | Override if your daemon listens elsewhere (e.g. rootless `~/.docker/desktop/docker.sock`). |
| `SM_ENABLE_LOG_STREAMING` | (on) | Set to `0` to suppress automatic log tailing on connect. |

The enrollment-token start command for Docker omits any
`SM_AGENT_RUNTIME_OVERRIDE` — Docker is the default branch in the
agent's `kaiad hello` switch.

**Caveats**

- The agent never spawns a Docker daemon. If the daemon is down the
  agent stays connected to Kaiad but `docker_op` returns errors.
- On Docker Desktop hosts the socket lives at a different path; either
  symlink to `/var/run/docker.sock` or set `SM_DOCKER_SOCKET`.

**Verify**

```bash
# Should print the daemon's API version, not connection refused.
curl --unix-socket "$SM_DOCKER_SOCKET" http://localhost/_ping
```

---

## Podman

Podman speaks the Docker API on a local socket (when launched with
`podman system service`). The agent treats Podman as a Docker drop-in:
same code path, different socket path.

**What you get**

- Everything Docker gives you, except: rootless containers by default,
  no daemon process, and friendlier permissions on RHEL-family /
  SELinux hosts.

**Prerequisites**

- `podman` 4.0+ on the host.
- The Podman API socket activated. Two common ways:
  - **System service (root)**:
    ```bash
    sudo systemctl enable --now podman.socket
    # socket is at /run/podman/podman.sock
    ```
  - **User service (rootless)**:
    ```bash
    systemctl --user enable --now podman.socket
    # socket is at $XDG_RUNTIME_DIR/podman/podman.sock
    ```

**Environment**

The runtime selector emits this in the start command:

```bash
SM_DOCKER_SOCKET=/run/podman/podman.sock /usr/local/bin/agent
```

For rootless Podman, override the socket path to your user runtime
dir:

```bash
SM_DOCKER_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock /usr/local/bin/agent
```

**Caveats**

- Podman exposes the Docker API but a few niche endpoints differ in
  behavior. The operations the agent uses (`ping`, list containers,
  start/stop, exec, build) are all covered.
- `compose_up` / `compose_down` shell out to a literal `docker-compose`
  binary today, not `docker compose` v2. On Podman hosts either install
  `podman-compose` and symlink it as `docker-compose`, or install the
  classic `docker-compose` binary and export
  `DOCKER_HOST=unix:///run/podman/podman.sock` so it talks to the
  Podman socket.
- Rootless Podman's networking model differs from Docker (slirp4netns
  by default). If your auto-fix workflow assumes host networking,
  validate it on a real Podman host before relying on it.

**Verify**

```bash
SM_DOCKER_SOCKET=/run/podman/podman.sock \
  curl --unix-socket /run/podman/podman.sock http://localhost/_ping
```

---

## Shell

The agent runs commands directly on the host. There is no container
indirection — `run_step` shells out via `bash -c`, plan executors run
the configured CLI in a temp workspace under `/tmp`, and there is
**no** `docker_op` support.

A small process supervisor (`internal/processsup`) handles the
`sync_desired_state` flow: it reconciles desired processes against
running ones, redirects each process's stdout/stderr to a log file
under `/tmp/sm-agent`, and tails those files through the same log
shipper Docker hosts use.

**What you get**

- Works on any Linux/macOS host with no container runtime.
- Plan executors run with the agent's own UID and PATH — no isolation
  per execution. This is convenient for development hosts and
  appropriate when the agent itself is the workload boundary.
- Suitable for shell-only services (a Java or Python process with no
  Docker wrapper) where Kaiad's job is mostly observation + auto-fix.

**Prerequisites**

- The CLIs the agent needs to execute on your host's PATH:
  - `git` for plan/fix workspaces.
  - `cursor` and/or `claude` if you use the corresponding executors.
  - Whatever the workload itself uses (`go`, `node`, `python3`, etc.).

**Environment**

```bash
SM_AGENT_RUNTIME_OVERRIDE=shell /usr/local/bin/agent
```

| Variable | Default | Purpose |
|---|---|---|
| `SM_AGENT_RUNTIME_OVERRIDE` | (unset) | Set to `shell` to opt out of Docker. |
| `SM_LOGSHIP_BUFFER` | `50` | Lines of context kept per service for `app_log_error` frames. |

**Caveats**

- `docker_op` is disabled and the agent reports it as such on each
  call. If you need container ops, use Docker or Podman.
- The plan executors run uncontained. Treat the agent host as a trust
  boundary; don't run shell-runtime agents on hosts you wouldn't give
  the configured AI CLI shell access to.
- Process supervision uses `/tmp/sm-agent`. On hosts that wipe `/tmp`
  on reboot, agent-managed processes restart from scratch on each
  reboot — fine for dev, surprising for prod.

**Verify**

After enrollment, confirm the runtime in the agent log:

```text
kaiad hello: agent runtime backend=shell
shell-runtime supervisor + tailer wired (agent=...)
```

---

## Kubernetes

The agent runs inside a pod and uses its mounted ServiceAccount token
to talk to the kube API. This is the runtime the
[Kaiad agent operator]({% link agent/kubernetes.md %}) installs by
default — applying a `KaiadAgent` CR is the recommended path; manual
installation on Kubernetes is unusual.

**Environment**

```bash
SM_AGENT_RUNTIME_OVERRIDE=kubernetes /usr/local/bin/agent
```

The operator also sets `SM_AGENT_PERSIST_CREDENTIALS=1` so the agent
records its post-enrollment credential into a mounted volume and
re-uses it across restarts.

**Caveats**

- `docker_op` is not yet mapped for kubernetes — the agent returns
  `docker_op is not mapped for "kubernetes" runtime yet; use run_step
  with kubectl`. Plan to wire `kubectl rollout restart` and `kubectl
  apply -f` for the common operations once the operator stabilizes.
- The agent's view of "the workload" is whatever the
  `KaiadAgent.spec.manages` allow-list grants it. If a Deployment is
  outside the rule list, the agent can't see it. This is intentional —
  see the [allow-list reference]({% link agent/kubernetes.md %}#rbac-scope-what-manages-actually-allows).

For everything else, see the dedicated
[Install on Kubernetes]({% link agent/kubernetes.md %}) page.

---

## Switching runtimes on a running host

Re-enroll. The runtime is set at agent startup from `kaiad hello` plus
`SM_AGENT_RUNTIME_OVERRIDE`; changing it in-place means restarting the
agent process with new env. The simplest path is:

1. Generate a fresh enrollment token in the panel with the runtime you
   want (Agents → Enrollment Tokens → pick runtime → Generate token).
2. Stop the agent, delete its credential file
   (`~/.service-monitor/agent-credential.json` by default; override
   with `SM_CREDENTIAL_PATH`), and run the new start command.

The platform's view of the agent doesn't change — the same agent id
re-enrolls under the new credential.

## Choosing

Most teams want **Docker**. Pick **Podman** if your host policy
forbids the Docker daemon. Pick **Shell** for hosts with no container
runtime, or where the workload itself runs as a host process and you
want supervised tailing + auto-fix without a container layer. Use
**Kubernetes** when you have a cluster — and prefer the
[operator install]({% link agent/kubernetes.md %}) over hand-rolling
the manifests.
