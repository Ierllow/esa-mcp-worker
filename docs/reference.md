# Technical Reference

This document contains the operational details intentionally omitted from the README.

## MCP Profiles

`/mcp-fast` exposes the small read-only catalog used for normal context conversations:

- `esa_load_context_entry`
- `esa_get_post`
- `esa_search_posts`
- `esa_read_sections`
- `esa_check_context_drift`

`/mcp` exposes the complete catalog for maintenance, implementation sync, and transcription. It adds comments, backlinks, categories, tags, create and update operations, patches, bulk operations, context-observer refresh, repository operations, and transcription. Compact, outline, excerpt, and Markdown reads are modes of `esa_get_post` rather than separate tools.

All esa tools accept an optional `team_name`. When omitted, the server uses `ESA_DEFAULT_TEAM`; explicit values remain available for multi-team use.

`esa_lint_active_page_registry` is available only on `/mcp`. It parses the configured YAML registry and checks live targets, archived references, successors, reachability, and KV observer coverage.

The server instructions ask a client to call `esa_load_context_entry` once before its first answer. MCP clients retain control over tool selection. Client-side skills are not part of this runtime design; canonical rules remain in the configured esa entry and its linked posts.

OpenAI-namespaced tool invocation labels are optional presentation metadata. Other MCP clients can ignore them; no esa read or write operation depends on them.

## Read Workflow

- Keep the entry post small and answer-ready.
- Load the current summary only for broad current-context questions.
- Prefetch explicitly named posts through `esa_load_context_entry` to avoid another model/tool round trip.
- Use `outline` for document structure, `excerpt` for focused questions, and bounded `markdown` only for full comparison.
- Use batch post, query, and section inputs instead of separate calls.
- Do not reread a completed result unless it was truncated or the source may have changed.

`esa_get_post` supports metadata, outline, excerpt, and Markdown modes for one post or up to ten in one call. Body modes share a bounded character budget and return a continuation offset when needed.

`esa_search_posts` accepts up to 10 independent queries. Searches run concurrently and preserve per-query failures. Bodies are returned only when `include_body` is true; the default is metadata and snippets.

## Write Workflow

Every write requires `confirm_write: true`.

- Use `esa_read_sections` for one or more heading sections of an article.
- Use `esa_patch_post` for one section or one text occurrence.
- Use `esa_patch_sections` for several non-overlapping sections in one article.
- Use `esa_append_post` for an append-only change.
- Use `esa_bulk_create_posts` or `esa_bulk_update_posts` for up to 20 articles.
- Use `esa_batch_move_category` only for a category tree. Use bulk update for selected posts.
- Pass `expected_revision_number` when a write depends on a prior read.

Patch and append tools fetch the current article server-side. The client sends only the intended change, while the server supplies esa revision data and invalidates its local read cache after success.

Completed writes return `operation_status: completed` and `needs_follow_up: false`. Partial bulk results identify failed and skipped items so the client does not reread successful articles.

## Context Observer

Observer configuration and revision baselines are stored in `MCP_CONFIG` KV under a team-specific key. The admin page manages post numbers, roles, read modes, and recommended sections.

Successful MCP article updates advance matching baselines asynchronously. Changes made in esa or another client remain visible as drift until `esa_refresh_context_observer` accepts them.

`ESA_CONTEXT_OBSERVER_POST_NUMBER` is only for a one-time import from a legacy esa observer article. New observer state is not written to esa.

## Implementation Sync

The full profile exposes five repository tools:

- `repo_get_snapshot` returns the configured branch head and file/blob catalog.
- `repo_read_files` reads selected files concurrently and returns blob SHAs.
- `repo_create_implementation_branch` creates one atomic commit on a managed branch or replaces that commit after a failed check.
- `repo_get_implementation_status` waits briefly for GitHub checks and commit statuses.
- `repo_publish_implementation` fast-forwards the default branch after successful checks and deletes the temporary branch.

Implementation changes never open a pull request. Creation requires the expected default-branch SHA and expected blob SHA for every existing file. Publication rechecks the base and head SHAs, requires at least one successful repository check, and uses `force: false` on the default branch. Missing, pending, or failed checks stop publication.

When a check fails, the client should briefly report it, inspect the returned summary and branch files, then replace the commit on the same branch by passing `branch` and `expected_branch_head_sha`. The replacement remains a single commit based on the original default-branch SHA. The client revalidates without waiting for another instruction and stops only when credentials, permissions, an external service, or an ambiguous requirement prevents a code fix.

Before writing, the client must complete the coding checklist for runtime behavior, MCP tool contracts, configuration and deployment, authentication and security, errors and audit, performance, tests, and documentation. Each area is marked `changed` or `not_affected` with a concrete reason. Git commit messages use a concise English title only; generated checklist or source-note bodies are not added.

Automatic changes block workflow files, environment files, and common private-key formats. A single update is limited to 12 files, 160 KiB per file, and 400 KiB total.

Cloudflare Workers Builds must run `pnpm verify` and enable non-production branch builds. The Cloudflare GitHub integration then reports branch builds as GitHub check runs.

Repository access uses a GitHub App installed only on the configured repository. Grant the App `Contents: Read and write`, `Checks: Read`, and `Commit statuses: Read`. `GITHUB_APP_PRIVATE_KEY` stays in Cloudflare encrypted secrets; the Worker signs a short-lived App JWT, mints an installation token, and caches that token only until shortly before expiration. OAuth clients do not submit or retain GitHub credentials.

## OAuth And Credentials

The server publishes OAuth protected-resource and authorization-server metadata. It supports PKCE S256, Dynamic Client Registration, and public clients with token endpoint authentication method `none`.

`MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` is a comma-separated exact hostname allowlist. Configure `chatgpt.com` and `claude.ai` when both clients are used. Add another client only by adding its documented HTTPS callback hostname. Arbitrary redirects, embedded credentials, and non-HTTPS callbacks are rejected.

The esa token is encrypted into the signed MCP access token and is not stored as plaintext in KV. Optional remembered-browser credentials use an encrypted, signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie scoped to `/oauth`. Rotating the OAuth passcode or revoking all sessions invalidates it. GitHub App credentials are deployment configuration and never enter the MCP OAuth exchange.

## Security And Audit

Stored operational data is limited to timestamps, connection and client IDs, callback hosts, esa user IDs and scopes, IP hashes, tool names, status, coarse targets, durations, and structured error identifiers.

The server does not log article bodies, comment bodies, search queries, esa tokens, GitHub credentials, or repository file bodies.

Audit levels:

- `minimal`: authentication and admin events, failures, slow successes, and large results
- `all`: every tool call, intended only for temporary debugging
- `none`: no audit rows

Connection usage writes are throttled by `MCP_CONNECTION_WRITE_INTERVAL_SECONDS`. Counts in the dashboard are sampled unless the interval is `0`.

## Error Contract

Tool failures return `isError: true` with structured details:

```json
{
  "ok": false,
  "error": {
    "source": "esa_api",
    "domain_status": "esa_permission_denied",
    "message": "esa API request failed: 403 Forbidden",
    "message_ja": "esaの権限が不足しています。",
    "hint": "Check the token scope and team name.",
    "http_status": 403
  }
}
```

Use `domain_status` for application behavior and `source` to locate the failing layer. `http_status` is supporting transport information. Japanese messages and parameter labels are centralized in `src/core/error-catalog.ts`.

## Performance

- `/mcp-fast` constructs only five public tool definitions.
- Registry lint performs no YAML parsing or esa reads until its full-profile tool is invoked.
- Static instructions, schemas, and annotations are reused per Worker isolate.
- Independent esa reads and searches use batch inputs and concurrent server requests.
- Large structured results are not duplicated in visible text.
- Eligible esa GET responses use a small token-scoped in-memory cache.
- Context, write-before-read, and drift-sensitive paths bypass that cache.
- Audit, connection tracking, and observer synchronization use `waitUntil()` where possible.
- Normal reads avoid KV writes.

Every tool result includes `elapsed_ms` and `elapsed_seconds` for Worker-side execution. This excludes client scheduling, model reasoning, connector transfer, and rendering.

## Configuration

Secrets:

- `MCP_BEARER_TOKEN`
- `MCP_OAUTH_PASSCODE`
- `MCP_ADMIN_PASSWORD`
- `GITHUB_APP_PRIVATE_KEY`

Variables:

- `ESA_DEFAULT_TEAM`
- `ESA_CONTEXT_ENTRY_POST_NUMBER`
- `ESA_CONTEXT_SUMMARY_POST_NUMBER`
- `ESA_CONTEXT_OBSERVER_POST_NUMBER`, legacy migration only
- `ESA_ACTIVE_PAGE_REGISTRY_POST_NUMBER`
- `ESA_VALIDATION_POST_NUMBER`
- `GITHUB_REPOSITORY`
- `GITHUB_DEFAULT_BRANCH`
- `GITHUB_BRANCH_PREFIX`
- `GITHUB_REQUIRED_CHECK_NAMES`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `MCP_ADMIN_USERNAME`
- `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`
- `MCP_AUDIT_LEVEL`
- `MCP_SLOW_TOOL_THRESHOLD_MS`
- `MCP_CONNECTION_WRITE_INTERVAL_SECONDS`

KV binding:

- `MCP_CONFIG`

## Verification

```sh
pnpm test
pnpm typecheck
pnpm exec wrangler deploy --dry-run
```
