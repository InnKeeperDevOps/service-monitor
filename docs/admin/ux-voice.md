---
title: UX Voice & Terminology
nav_order: 9
---

# UX voice & terminology

Guidance for in-product copy, errors, and documentation so the admin experience stays consistent with the **Control Slate** product voice.

## Voice

- **Direct, calm, precise.** Say what the user needs to know without filler.
- **Prefer plain language.** Avoid jargon where possible. When a technical term is required, **link to the glossary or reference** so readers can go deeper.
- **Active voice.** Prefer “We queued the remediation plan” over passive constructions.
- **Errors** should briefly explain **what happened**, include a **stable code** (and **correlation ID** when available), and suggest a **concrete next action** (where to click or what to change).

## Terminology map

Use the preferred term on the left in UI, API messages, and docs. Avoid the alternatives unless you are quoting external systems.

| Preferred | Avoid |
|-----------|--------|
| **incident** | “alert”, “issue” |
| **remediation plan** | “fix”, “patch” |
| **agent** | “client”, “daemon” |
| **enrollment** | “registration”, “onboarding” |
| **policy deny** | “blocked”, “forbidden” |
| **dry run** / **test run** | “simulation”, “preview” |
| **tenant** | “organization”, “account” |

## Error message pattern

Structure product and API errors as:

**What happened → Code (and correlation ID) → What to do next**

Keep each segment short; put details in logs or linked docs when needed.

### Example

> GitHub merge denied — **POLICY_DENY** (correlation: **abc-123**) — Update automation policy in **Settings → Automation** to allow `merge_pr` for this repository.
