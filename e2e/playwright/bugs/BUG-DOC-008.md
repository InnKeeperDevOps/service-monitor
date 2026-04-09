# BUG-DOC-008: SSRF T-SEC-004 and KMS/mTLS lifecycle risks absent from AGENTS.md

**Detected by:** Manual review vs `.cursor/plans/service_monitor_platform_5fd05388.plan.md` (overview frontmatter + risks section)
**Severity:** Low
**Status:** Open

---

## Summary

The platform plan overview explicitly names two security requirements:

1. **SSRF redirect case T-SEC-004** — "Enforce SSRF-safe outbound URL checks (including redirect chain validation) across runtime integrations" (also a completed todo: `ssrf-runtime-enforcement`).
2. **KMS/rotation/mTLS lifecycle** — listed under main risks for production hardening.

Neither is mentioned in `service-monitor/AGENTS.md`. Implementers working on HTTP request nodes, GitHub jobs, or webhook ingress in the API need to know that SSRF redirect-chain validation is a hard requirement.

## Expected behaviour

`service-monitor/AGENTS.md` should note:
- SSRF-safe outbound URL checks (including redirect-chain validation) are required across all runtime integrations (api, worker, agent).
- KMS/mTLS lifecycle and key rotation are production hardening requirements tracked under risks.

## Actual behaviour

`AGENTS.md` lists four non-negotiables (contracts, coverage, no in-memory auth, env precedence) but does not mention SSRF or KMS/rotation requirements.

## Fix direction

Add a fifth non-negotiable (or a dedicated Security section):

```markdown
5. **SSRF protection** — all outbound HTTP calls (webhook deliveries, GitHub API, `httpRequest` workflow nodes) must validate the full redirect chain against an allowlist. Redirects to private IPs or metadata endpoints must be blocked (see test case T-SEC-004).
```

And a note on KMS/mTLS:

```markdown
6. **Secrets and mTLS lifecycle** — GitHub App private keys and agent credentials must be stored with rotation in mind (KMS or equivalent). mTLS for agent transport is a planned production-hardening option.
```
