# BUG-DOC-001: Jekyll docs site absent from service-monitor/AGENTS.md

**Detected by:** Manual review vs `.cursor/plans/service_monitor_platform_5fd05388.plan.md` and `PROJECT_DEFINITION.md`
**Severity:** Medium
**Status:** Open

---

## Summary

The `docs-jekyll` todo in the platform plan is marked **completed** ("Jekyll site in docs/: Gemfile, theme, GitHub Actions build+Pages deploy"). `PROJECT_DEFINITION.md` lists it in the tech stack ("Docs: Jekyll site under `docs/` (GitHub Pages)"). Neither the **Apps** section nor the **Tech stack** section of `service-monitor/AGENTS.md` mentions the `docs/` Jekyll site.

## Expected behaviour

`service-monitor/AGENTS.md` should list the Jekyll documentation site (under `docs/`) alongside the other apps and in the tech stack table, so implementers working in that tree know it exists and which rules apply.

## Actual behaviour

`service-monitor/AGENTS.md` enumerates only `apps/web`, `apps/api`, `apps/worker`, and `apps/agent`. The docs site is invisible to agents reading only that file.

## Fix direction

Add a fifth app entry to the **Apps** section of `service-monitor/AGENTS.md`:

```markdown
#### `docs/` — Jekyll operator documentation (GitHub Pages)

- **Content** — install guide, security hardening, agent networking, operational runbooks (Redis/Postgres/realtime/worker failure), and reference MVP deployment notes.
- **Build** — Gemfile + just-the-docs (or equivalent theme); `SCSS` uses Control Slate primary/link hex to match the admin SPA.
- **Deploy** — GitHub Actions builds and deploys to GitHub Pages on every push to `main`.
```

Also add `Docs: Jekyll site under docs/ (GitHub Pages)` to the tech stack list.
