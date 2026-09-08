#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
BRANCH="${WORKERS_CI_BRANCH:-preview}"
SHA="${WORKERS_CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
SLUG="$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g;s/^-+//;s/-+$//' | cut -c1-24)"
ALIAS="e2e-${SLUG:-preview}-${SHA:0:8}"

OUTPUT="$(pnpm exec wrangler versions upload --preview-alias "$ALIAS" --var "MCP_E2E_PREVIEW_BEARER_TOKEN:$TOKEN" 2>&1)"
printf '%s\n' "$OUTPUT"
ORIGIN="$(printf '%s\n' "$OUTPUT" | sed -n 's/^Version Preview URL: \(https:\/\/[^ ]*\)$/\1/p' | tail -n1)"
VERSION="$(printf '%s\n' "$OUTPUT" | sed -n 's/^Worker Version ID: \(.*\)$/\1/p' | tail -n1)"
if [[ -z "$ORIGIN" || -z "$VERSION" ]]; then
  echo "Exact preview URL/version missing from wrangler output." >&2
  exit 1
fi

bash scripts/e2e-public.sh "$ORIGIN" "$TOKEN" "$VERSION"
printf 'E2E evidence sha=%s preview=%s version=%s\n' "$SHA" "$ORIGIN" "$VERSION"
