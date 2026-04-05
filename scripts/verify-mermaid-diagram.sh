#!/usr/bin/env bash
# Verifies the architecture Mermaid diagram for the docs site.
# 1) Jekyll build + assert <pre class="mermaid"> contains literal "-->" (not "--&gt;").
#    Kramdown escapes ">" inside normal HTML; we wrap the include in {::nomarkdown}.
# 2) Optional: same source as docs/internal/mermaid-architecture.mmd (keep in sync).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS="$ROOT/docs"

if [[ ! -d "$DOCS" ]]; then
  echo "missing $DOCS" >&2
  exit 1
fi

export GEM_HOME="${GEM_HOME:-$HOME/.gem}"
export PATH="$GEM_HOME/bin:$HOME/.local/share/gem/ruby/3.3.0/bin:$PATH"

if ! command -v bundle >/dev/null 2>&1; then
  echo "SKIP: bundle not on PATH (install Ruby + bundler to run the Jekyll check)."
  exit 0
fi

if [[ ! -f "$DOCS/Gemfile" ]]; then
  echo "SKIP: no docs/Gemfile"
  exit 0
fi

(
  cd "$DOCS"
  bundle config set --local path 'vendor/bundle' 2>/dev/null || true
  bundle install --quiet
  bundle exec jekyll build --quiet
)

python3 << PY
import re
from pathlib import Path
html = Path("$DOCS/_site/index.html").read_text(encoding="utf-8")
m = re.search(r"<pre class=\"mermaid\">(.*?)</pre>", html, re.DOTALL)
if not m:
    raise SystemExit("FAIL: no <pre class=\"mermaid\"> in _site/index.html")
body = m.group(1)
if "--&gt;" in body:
    raise SystemExit("FAIL: Kramdown escaped arrows (--&gt;). Check {::nomarkdown} wrapper in docs/index.md")
if "-->" not in body:
    raise SystemExit("FAIL: expected literal --> in mermaid source")
print("OK: Jekyll output has valid mermaid <pre> (literal arrows and brackets)")
PY

echo "Diagram source of truth: docs/internal/mermaid-architecture.mmd (sync with _includes/mermaid-architecture.html)"
