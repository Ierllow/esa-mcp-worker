# esa MCP Worker

A vendor-neutral Remote MCP server for [esa](https://esa.io/) on Cloudflare
Workers. It exposes read, write, context, audit, admin, and optional GitHub
implementation tools to MCP clients.

## What it provides

- `/mcp-fast`: a small read-only catalog for normal context lookup
- `/mcp`: the complete catalog for writes, maintenance, transcription, and GitHub sync
- OAuth with PKCE, Dynamic Client Registration, and single-use authorization codes
- bounded reads, section patches, bulk operations, caching, and concurrent requests
- an admin page for access, audit, connections, and context-observer management

## Requirements

- Node.js 24.11 or later
- pnpm 10.11.1
- a Cloudflare account
- an esa access token

## Setup

1. Install dependencies.

   ```sh
   pnpm install --frozen-lockfile
   pnpm verify
   ```

2. Create a Workers KV namespace and a D1 database in Cloudflare. Replace the
   two placeholder IDs in `wrangler.jsonc` with the IDs from your account.

   ```sh
   pnpm exec wrangler kv namespace create MCP_CONFIG
   pnpm exec wrangler d1 create esa-mcp-worker-oauth-codes
   pnpm exec wrangler d1 migrations apply esa-mcp-worker-oauth-codes --remote
   ```

3. In Cloudflare `Workers & Pages > Settings > Variables and Secrets`, add the
   values shown in `.dev.vars.example`. At minimum, configure:

   ```text
   ESA_DEFAULT_TEAM
   ESA_CONTEXT_ENTRY_POST_NUMBER
   MCP_ADMIN_USERNAME
   MCP_OAUTH_ALLOWED_REDIRECT_HOSTS
   MCP_BEARER_TOKEN             secret
   MCP_OAUTH_PASSCODE           secret
   MCP_ADMIN_PASSWORD           secret
   ```

   Use long random values for all three secrets. GitHub implementation sync is
   optional.

4. Deploy.

   ```sh
   pnpm run deploy
   ```

For Cloudflare Workers Builds, use:

```text
Build command:                 pnpm verify
Deploy command:                pnpm run deploy
Non-production deploy command: pnpm run deploy:preview
```

`deploy:preview` uploads a version with a one-time `MCP_E2E_PREVIEW_BEARER_TOKEN`
and runs `scripts/e2e-public.sh` against that version's exact preview URL. The
check covers root health, OAuth metadata, both tool catalogs, and the `/mcp-fast`
read-only boundary. The preview bearer works only on the version preview host
whose name starts with that version ID, and it carries no esa credential, so
esa tool calls made with it fail before any request leaves the Worker. The E2E
also verifies that `X-MCP-Runtime-Version` exactly matches the uploaded version.
To rerun the check by hand, use
`pnpm e2e <preview-origin> <preview-bearer> <worker-version-id>`.

## Connect an MCP client

Use one endpoint at a time to keep the tool catalog small:

```text
Read-only: https://YOUR-WORKER.workers.dev/mcp-fast
Full:      https://YOUR-WORKER.workers.dev/mcp
Admin:     https://YOUR-WORKER.workers.dev/admin
```

Prefer Dynamic Client Registration. For a manual OAuth client, use token
endpoint authentication method `none`, PKCE S256, and these endpoints:

```text
Authorization: https://YOUR-WORKER.workers.dev/oauth/authorize
Token:         https://YOUR-WORKER.workers.dev/oauth/token
Registration:  https://YOUR-WORKER.workers.dev/oauth/register
```

Scopes are `esa:read` for `/mcp-fast` and `esa:read esa:write` for `/mcp`.
Reconnect a client after the public tool catalog changes.

## Repository layout

- `src/index.ts`: Worker entry point and route dispatch
- `src/admin/`: admin UI and handlers
- `src/auth/`: OAuth and authorization-code storage
- `src/core/`: shared configuration, security, HTTP, errors, types, and utilities
- `src/esa/`: esa API client, bounded reads, section parsing, context
  observation, and writes (`esa.ts` keeps the existing import path)
- `src/github/`: GitHub authentication, API client, repository reads,
  validation, and implementation workflow (`github.ts` keeps the import path)
- `src/mcp/`: MCP server assembly, tool registration, and schemas
- `src/state/`: registry, observer, and cache state
- `tests/`: bundled integration tests
- `scripts/`: local verification and Cloudflare preview E2E

In `src/esa/`, `src/github/`, and `src/mcp/`, implementation files use
`<domain>-<role>.ts`; the short `<domain>.ts` file preserves existing imports.
See [docs/contributing.md](docs/contributing.md) for TypeScript and file conventions.

## Security

Do not commit `.dev.vars`, `.env`, real Cloudflare resource IDs, tokens, or
private keys. The Worker encrypts esa credentials into the signed OAuth access
token and does not store their plaintext in KV. Write tools
also require `confirm_write: true`.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and
[docs/reference.md](docs/reference.md) for tools, configuration, errors,
performance, and the optional GitHub workflow.

## License

[MIT](LICENSE) Copyright (c) 2026 Ierllow
