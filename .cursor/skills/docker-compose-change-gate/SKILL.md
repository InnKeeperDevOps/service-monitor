---
name: docker-compose-change-gate
description: >-
  Gates edits to deploy/docker/compose.yml and deploy/docker/compose.unified.yml.
  Use whenever a task might touch Docker Compose, when the user mentions merge
  conflicts on compose files, or when considering env/volume/service wiring in deploy YAML.
---

# Docker Compose change gate (service-monitor)

## Scope

Applies only to:

- `deploy/docker/compose.yml`
- `deploy/docker/compose.unified.yml`

`compose.unified.yml` in particular is a **frequent merge-conflict** surface. Treat it as **high friction**: avoid drive-by edits.

## Default

- **Do not change** these files unless:
  - the user explicitly requested a deploy/compose change, **or**
  - you have stated a **concrete reason** the change is **necessary** (not optional) and the user **approved** editing the YAML.

- Prefer **code**, **config via env** documented elsewhere, or **runtime behavior** over editing compose.

## When a compose change seems needed

1. **Stop** — do not edit yet.
2. Write a short **proposal**:
   - **File(s)** and exact intent (e.g. new env var, volume name, port).
   - **Why** it cannot be solved without touching compose (or why skipping compose would be wrong).
   - **Risk** — e.g. merge conflicts, drift between `compose.yml` and `compose.unified.yml`.
3. **Ask the user** to confirm before modifying.

## If the user says no

Implement the feature without compose changes, or document manual steps for operators.

## If the user says yes

- Make the **minimal** diff.
- If both compose files usually stay in sync for the same concern, mention whether both need updates or only one — **ask** if unsure.

## Anti-patterns

- “While I’m here” volume or networking tweaks.
- Duplicating the same cosmetic change across files without user context.
- Editing `compose.unified.yml` when only `compose.yml` (or vice versa) was discussed — clarify first.
