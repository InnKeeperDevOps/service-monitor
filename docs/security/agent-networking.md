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
- **Local scope**: Docker/Compose and local runners use **local** APIs (e.g. Docker socket); separate from SaaS network policy.

## Hardening checklist

- **TLS** end-to-end at the edge; terminate at LB or gateway per deployment.
- **Agent identity**: enforce **token** or **mTLS** per product contract; rotate on compromise.
- **Path isolation**: restrict agent WSS route exposure vs browser HTTPS (separate listener or strict routing).
- **Egress from jobs**: outbound HTTP requests and webhook deliveries run in **privileged** contexts—treat as **SSRF-sensitive**; allowlist where possible.

## Validation checks

- From agent host: **WSS** handshake succeeds to configured `SM_REALTIME_URL` (or equivalent).
- Firewall: **deny** unsolicited inbound to agent; **allow** only required local ports.
- Audit: agent **enrollment** and **command** delivery events match expected tenant and agent IDs.
