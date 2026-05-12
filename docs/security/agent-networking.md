---
title: Agent networking
parent: Security
nav_order: 1
---

# Agent networking

Customer **agents** run on customer infrastructure and connect **outbound** to the SaaS **realtime** endpoint; they are not a public ingress surface for the control plane.

## Model

- **Egress-only to SaaS**: Agent initiates **WSS** (typically **443/TLS**); customer firewall allows outbound to your **hostname(s)** and port.
- **No required inbound** to the agent for the SaaS path: **Worker → gateway → existing session** delivers **AgentCommand**; the agent does not open a listener for the platform.
- **Image pulls**: when the agent deploys a service Kaiad built (`<KAIAD_REGISTRY_HOST>/<service>:<sha>`), the **host docker daemon or cluster kubelet** — *not the agent process itself* — pulls from the [built-in OCI registry]({% link reference/registry.md %}) over **HTTPS/443** to the same hostname as the realtime URL. The agent presents a pre-minted bearer (`registrytoken`) so the kubelet authenticates without operator setup.
- **Local scope**: Docker/Compose and local runners use **local** APIs (e.g. Docker socket); separate from SaaS network policy.

## Egress allowlist

| Destination | Port / Protocol | Used by | Notes |
|------------|----------------|---------|-------|
| `<panel-host>/realtime` | 443 / WSS | Agent process | Long-lived control channel. |
| `<panel-host>/api/v1/*` | 443 / HTTPS | Agent process | Heartbeats, log frames, command acks. |
| `<panel-host>/v2/*`, `<panel-host>/registry/token` | 443 / HTTPS | Host docker daemon **or** k8s kubelet | Image pulls of services Kaiad builds. Only needed when an agent runtime backend (docker / kubernetes) actually deploys Kaiad-hosted images. |

In single-hostname deployments all three paths share one DNS entry and TLS cert — a single allowlist rule covers everything.

## Hardening checklist

- **TLS** end-to-end at the edge; terminate at LB or gateway per deployment.
- **Agent identity**: enforce **token** or **mTLS** per product contract; rotate on compromise.
- **Path isolation**: restrict agent WSS route exposure vs browser HTTPS (separate listener or strict routing).
- **Registry pull credentials**: pull tokens issued to agents are **pull-only**; never grant push to a kubelet's image-pull Secret. Push is reserved for the build worker, which mints its own JWTs in-process.
- **Egress from jobs**: outbound HTTP requests and webhook deliveries run in **privileged** contexts—treat as **SSRF-sensitive**; allowlist where possible.

## Validation checks

- From agent host: **WSS** handshake succeeds to configured `SM_REALTIME_URL` (or equivalent).
- From the same host: `curl -sSf https://<panel-host>/v2/` returns **401** with a `WWW-Authenticate: Bearer …` challenge (not a TCP error). That proves egress + TLS + DNS to the registry surface.
- Firewall: **deny** unsolicited inbound to agent; **allow** only required local ports.
- Audit: agent **enrollment** and **command** delivery events match expected tenant and agent IDs.
