# Docs screenshots

PNG screenshots referenced from the docs site live here. They are
**generated**, not hand-curated: the Playwright spec at
`e2e/playwright/tests/docs-screenshots.spec.ts` drives a real Kaiad
panel, navigates to each page, and writes a PNG with a stable
filename.

## Regenerate

```sh
# Against your dev Kaiad (the unified-container compose stack).
KAIAD_DOCS_BASE_URL=http://127.0.0.1:8092 \
KAIAD_DOCS_TOKEN=<owner-bearer-token> \
PW_SKIP_WEBSERVER=1 \
BASE_URL=http://127.0.0.1:8092 \
pnpm --filter @sm/playwright-e2e exec playwright test docs-screenshots
```

What that does:

- Loads `sm_token` from `KAIAD_DOCS_TOKEN` into localStorage.
- Navigates to each panel route (Dashboard, Agents, Services, Builds,
  Registry, SSH Keys, Load Balancers) and the new-service form.
- Writes PNGs into `docs/assets/screenshots/` with the names the
  markdown pages reference.

Run against your dev environment, not prod — these images get
committed to the public docs site. Keep tenant names, domains, and
service names generic in whatever environment you regenerate from.

If the spec doesn't have a `KAIAD_DOCS_TOKEN` set it skips every
capture test (so default CI doesn't fail on a missing panel).

## Adding a new screenshot

1. Add a capture step to the spec (`e2e/playwright/tests/docs-screenshots.spec.ts`).
2. Reference it from the relevant `docs/**/*.md` page as
   `![alt text](/assets/screenshots/<name>.png)`.
3. Run the regenerate command above to produce the PNG.
4. Commit both the spec change and the PNG together.
