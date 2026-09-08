#!/usr/bin/env bash
set -euo pipefail

ORIGIN="${1:?preview origin required}"
TOKEN="${2:?preview bearer required}"
VERSION="${3:?worker version id required}"
PROTOCOL="${MCP_E2E_PROTOCOL_VERSION:-2025-11-25}"

pass() { printf 'E2E PASS %s\n' "$1"; }
fail() {
  printf 'E2E FAIL %s: %s\n' "$1" "$2" >&2
  [[ -n "${3:-}" ]] && printf '%s\n' "$3" | head -c 1200 >&2 && printf '\n' >&2
  exit 1
}
require() {
  local value="$1" needle="$2" label="$3"
  grep -Fq -- "$needle" <<<"$value" || fail "$label" "missing $needle" "$value"
}
forbid() {
  local value="$1" needle="$2" label="$3"
  if grep -Fq -- "$needle" <<<"$value"; then fail "$label" "unexpected $needle" "$value"; fi
}
request() {
  local path="$1" body="$2" raw data
  raw="$(curl -fsS --max-time 30 "$ORIGIN$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "MCP-Protocol-Version: $PROTOCOL" \
    --data-binary "$body")" || fail "$path" "request failed"
  data="$(printf '%s\n' "$raw" | sed -n 's/^data:[[:space:]]*//p' | tail -n1)"
  printf '%s' "${data:-$raw}"
}
tools_list() { request "$1" '{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}'; }

root_headers="$(mktemp)"
trap 'rm -f -- "$root_headers"' EXIT
root="$(curl -fsS --max-time 20 -D "$root_headers" "$ORIGIN/")"
require "$root" '"status":"ok"' root-health
require "$root" '"mcp_endpoint":"/mcp"' root-health
require "$root" '"fast_mcp_endpoint":"/mcp-fast"' root-health
runtime_version="$(awk 'tolower($0) ~ /^x-mcp-runtime-version:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }' "$root_headers")"
[[ "$runtime_version" == "$VERSION" ]] || fail root-health "runtime version mismatch: expected $VERSION, got ${runtime_version:-missing}"
pass root-health

metadata="$(curl -fsS --max-time 20 "$ORIGIN/.well-known/oauth-protected-resource")"
require "$metadata" 'esa:read' oauth-metadata
require "$metadata" 'esa:write' oauth-metadata
for path in /mcp /mcp-fast; do
  endpoint_metadata="$(curl -fsS --max-time 20 "$ORIGIN/.well-known/oauth-protected-resource$path")"
  require "$endpoint_metadata" "\"resource\":\"$ORIGIN$path\"" "oauth-metadata$path"
done
pass oauth-metadata

challenge="$(curl -sS --max-time 20 -o /dev/null -D - -X POST "$ORIGIN/mcp-fast" -H 'Content-Type: application/json' --data-binary '{}')"
require "$challenge" ' 401' unauthenticated-challenge
require "$(tr '[:upper:]' '[:lower:]' <<<"$challenge")" 'oauth-protected-resource/mcp-fast' unauthenticated-challenge
pass unauthenticated-challenge

full="$(tools_list /mcp)"
for name in esa_load_context_entry esa_get_post esa_search_posts esa_create_post esa_update_post; do
  require "$full" "\"name\":\"$name\"" full-tool-catalog
done
pass full-tool-catalog

fast="$(tools_list /mcp-fast)"
for name in esa_load_context_entry esa_get_post esa_search_posts esa_read_sections; do
  require "$fast" "\"name\":\"$name\"" fast-tool-catalog
done
for name in esa_create_post esa_update_post esa_bulk_update_posts repo_get_snapshot; do
  forbid "$fast" "\"name\":\"$name\"" fast-tool-catalog
done
pass fast-tool-catalog

isolated="$(request /mcp-fast '{"jsonrpc":"2.0","id":"isolated","method":"tools/call","params":{"name":"esa_get_post","arguments":{"post_number":1}}}')"
require "$isolated" '"isError":true' preview-upstream-isolation
require "$isolated" 'Preview E2E credentials cannot call the esa API' preview-upstream-isolation
pass preview-upstream-isolation
