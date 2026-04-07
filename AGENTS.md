# Agent instructions

All behavior for coding in this repository is governed by **`.cursor/rules/*.mdc`**. Those files are **binding** on every prompt, not optional guidance.

- Start with **`meta-all-rules-binding.mdc`** (always applies).
- Follow skills in **`.cursor/skills/`** when their description matches your task.

User-defined Cursor **User Rules** take precedence if anything conflicts.

## Always (every prompt)

1. Follow **Cursor → Settings → Rules → User Rules** on every turn.
2. Follow **`.cursor/rules/*.mdc`** here. Files with **`alwaysApply: true`** apply every turn; **glob-scoped** rules apply when you touch matching paths.

## Before every response (checklist)

1. **Always:** Apply **User Rules** in full on this turn.
2. **Always:** For substantive work, **list or read** **`.cursor/rules/*.mdc`** so nothing is missed (including glob rules for files you edit).
3. **If** a skill under **`.cursor/skills/`** matches the task, **read and follow** it first.
4. **If** you **`git push`** or updated **`origin`**: You are **not** done until you **monitor GitHub Actions** for that commit (see **`post-push-github-actions-monitor.mdc`**) and report workflow outcomes.
5. **If** you change **`apps/`** or **`packages/`** (or configs that affect build): Run **build + tests** for the impacted scope before claiming done (see **`verification-before-stopping-code-changes.mdc`**).
6. **If** you cannot run a required step: Say so **explicitly**; do not imply green CI or full compliance.

## Multi-root workspaces

If your Cursor workspace root is a **parent folder** that contains this repo (e.g. home + `service-monitor/`): also follow **`AGENTS.md`** and **`.cursorrules`** at that workspace root when present.
