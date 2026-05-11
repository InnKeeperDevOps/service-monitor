FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/agent ./cmd/agent

# Debian (glibc) instead of alpine (musl) so we can run the Claude
# Code CLI, which is distributed as a glibc-linked ELF binary. Adds
# git + openssh-client so executeRunFixPlan can clone the service
# repo, commit the auto-fix, and push back to the branch.
#
# The `claude` binary is NOT baked in — it's bind-mounted from the
# host at run time. That keeps the image free of any specific Claude
# Code version and avoids re-pushing the agent image on every CLI
# upgrade.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    # `claude` (uid 1000) is the credential the auto-fix runner switches
    # to when invoking the Claude Code CLI. Claude itself refuses to run
    # under uid 0 ("--dangerously-skip-permissions cannot be used with
    # root/sudo privileges"), but the agent process needs root for the
    # docker socket. Splitting via syscall.Credential keeps the docker
    # bits root while sandboxing claude to an unprivileged uid.
    && useradd -u 1000 -m -s /bin/sh claude
WORKDIR /app
COPY --from=build /out/agent /usr/local/bin/agent
ENTRYPOINT ["/usr/local/bin/agent"]
