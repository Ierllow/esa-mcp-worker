import { KV_OAUTH_PASSCODE_KEY, KV_SIGNING_SECRET_KEY } from "./constants";
import { serverConfigError } from "./errors";
import type { Env } from "./types";

const CONFIG_CACHE_TTL_MS = 30 * 1000;
const configCache = new Map<string, { value: string; expiresAt: number }>();

function readCachedConfig(key: string) {
  const cached = configCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    configCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function writeCachedConfig(key: string, value: string) {
  configCache.set(key, {
    value,
    expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
  });
}

export function clearConfigCache(key?: string) {
  if (key) {
    configCache.delete(key);
    return;
  }
  configCache.clear();
}

async function currentKvConfigValue(env: Env, key: string, fallback: () => string) {
  const cached = readCachedConfig(key);
  if (cached) {
    return cached;
  }

  const value = (await env.MCP_CONFIG?.get(key)) ?? fallback();
  writeCachedConfig(key, value);
  return value;
}

export function ensureMcpBearerToken(env: Env): string {
  if (!env.MCP_BEARER_TOKEN) {
    throw serverConfigError("MCP_BEARER_TOKEN is not configured.", "Run `pnpm exec wrangler secret put MCP_BEARER_TOKEN`.");
  }
  return env.MCP_BEARER_TOKEN;
}

export function ensureAdminPassword(env: Env): string {
  if (!env.MCP_ADMIN_PASSWORD) {
    throw serverConfigError("MCP_ADMIN_PASSWORD is not configured.", "Run `pnpm exec wrangler secret put MCP_ADMIN_PASSWORD`.");
  }
  return env.MCP_ADMIN_PASSWORD;
}

export function ensureAdminUsername(env: Env): string {
  if (!env.MCP_ADMIN_USERNAME) {
    throw serverConfigError("MCP_ADMIN_USERNAME is not configured.");
  }
  return env.MCP_ADMIN_USERNAME;
}

export async function currentSigningSecret(env: Env): Promise<string> {
  return currentKvConfigValue(env, KV_SIGNING_SECRET_KEY, () => ensureMcpBearerToken(env));
}

export async function currentOauthPasscode(env: Env): Promise<string> {
  return currentKvConfigValue(env, KV_OAUTH_PASSCODE_KEY, () => {
    if (!env.MCP_OAUTH_PASSCODE) {
      throw serverConfigError("MCP_OAUTH_PASSCODE is not configured.", "Run `pnpm exec wrangler secret put MCP_OAUTH_PASSCODE`.");
    }
    return env.MCP_OAUTH_PASSCODE;
  });
}

export function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
