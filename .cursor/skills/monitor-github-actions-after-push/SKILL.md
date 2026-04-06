---
name: monitor-github-actions-after-push
description: After any git push to GitHub, watches Actions workflow runs until completion, surfaces failures with logs, and triggers fix-and-repush loops. Use after push to main or PR branches, when user mentions CI, Actions, or workflow failure, or when finishing tasks that included a remote push.
---

# Monitor GitHub Actions after push

## When this applies

- Immediately **after** `git push` completes in this session.
- User says CI failed, Actions are red, or asks to check workflows.

## Procedure

1. **Confirm context**
   - Repo: `git remote get-url origin` (parse owner/repo).
   - Branch: current branch or the branch that was pushed.

2. **List recent runs**
   - Run: `gh run list --branch "$(git branch --show-current)" --limit 15`
   - If branch listing is wrong (e.g. pushed from another machine), use: `gh run list --limit 15` and match commit SHA with `git rev-parse HEAD` on the remote after fetch, or use the run URL from push output if Git printed it.

3. **Watch until settled**
   - For each in-progress run that applies to the latest push: `gh run watch <run-id>`
   - Or poll: `gh run list` until statuses are not `queued` / `in_progress`.

4. **On failure**
   - `gh run view <id> --log-failed` (or full `--log` if needed).
   - Summarize: workflow name, job name, failing step, root error lines.
   - Fix locally, run the same checks as CI for the touched area (`pnpm typecheck`, `pnpm test:coverage`, `pnpm build` as in root `package.json`), commit, push, **repeat monitoring from step 2**.

5. **If `gh` is unavailable or needs auth**
   - Say so clearly.
   - Give the Actions URL: `https://github.com/<owner>/<repo>/actions`
   - List which workflow files (`.github/workflows/*.yml`) apply and what they run so the user can validate manually.

## Repo-specific notes (kaiad / service-monitor)

- **ci**: lint, typecheck, test:coverage, build, Go tests in `apps/agent`, OpenAPI drift on PRs when contracts change.
- **acceptance**: Docker Compose in `deploy/docker` then `pnpm acceptance`.
- **docs**: Jekyll under `docs/`; deploy job on `main` push.

Do not claim CI passed without evidence from `gh` or explicit user confirmation after manual check.
