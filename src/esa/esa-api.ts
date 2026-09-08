import {
  E2E_PREVIEW_UPSTREAM_SENTINEL,
  ESA_API_BASE_URL,
  EsaCacheMode,
  EsaRequestAccess,
  HttpMethod,
} from "../core/constants";
import { esaApiError, inputError, serverConfigError, writeConfirmationError } from "../core/errors";
import type { Env, EsaRateLimitInfo, EsaRequestOptions, EsaTokenInfo } from "../core/types";
import { safeJsonParse } from "../core/utils";
import { invalidatePostCache, readCachedPost } from "../state/post-cache";
import { extractContextVersion } from "./esa-sections";

export type EsaPost = {
  number?: number;
  name?: string;
  full_name?: string;
  body_md?: string;
  category?: string;
  tags?: string[];
  wip?: boolean;
  url?: string;
  created_at?: string;
  updated_at?: string;
  revision_number?: number;
  comments_count?: number;
  stargazers_count?: number;
  watchers_count?: number;
  created_by?: { name?: string; screen_name?: string };
  updated_by?: { name?: string; screen_name?: string };
};

export async function validateEsaReadAccess(token: string, env: Env): Promise<EsaTokenInfo> {
  const teamName = resolveTeamName(undefined, env);
  const postNumber = resolveValidationPostNumber(env);

  if (!postNumber) {
    await esaGet({
      teamName,
      path: "/posts",
      token,
      searchParams: { per_page: 1 },
    });

    return { scope: ["read:post"] };
  }

  await esaGet({
    teamName,
    path: `/posts/${postNumber}`,
    token,
  });

  return { scope: ["read:post"] };
}

export async function esaRequest<T>(options: EsaRequestOptions): Promise<T> {
  const { teamName, path, token, method = HttpMethod.Get, access, searchParams, body, onRateLimit } = options;
  if (token === E2E_PREVIEW_UPSTREAM_SENTINEL) {
    throw inputError("Preview E2E credentials cannot call the esa API.", "Use an OAuth connection for esa reads and writes.");
  }
  return readCachedPost<T>({ ...options, method }, async () => {
    const url = new URL(`${ESA_API_BASE_URL}/teams/${encodeURIComponent(teamName)}${path}`);

    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        "User-Agent": "esa-mcp-worker/0.1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // esa reports its 300-req/15min window on every response; surface it so
    // callers (e.g. bulk tools) can report how much headroom is left.
    onRateLimit?.(parseRateLimitHeaders(response.headers));

    const responseText = await response.text();
    const parsedBody = responseText ? safeJsonParse(responseText) : null;

    if (!response.ok) {
      throw esaApiError({
        status: response.status,
        statusText: response.statusText,
        method,
        access,
        path,
        body: parsedBody ?? responseText,
      });
    }

    if (access === EsaRequestAccess.Write) {
      const postNumber = Number(/^\/posts\/(\d+)(?:\/|$)/.exec(path)?.[1]);
      if (postNumber) {
        invalidatePostCache(teamName, postNumber);
      }
    }

    return parsedBody as T;
  });
}

export async function esaGet<T>(options: Omit<EsaRequestOptions, "method" | "access">): Promise<T> {
  return esaRequest<T>({ ...options, method: HttpMethod.Get, access: EsaRequestAccess.Read });
}

function parseRateLimitHeaders(headers: Headers): EsaRateLimitInfo {
  const parseNumber = (value: string | null) => {
    if (value === null || value.trim() === "") {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const limit = parseNumber(headers.get("x-ratelimit-limit"));
  const remaining = parseNumber(headers.get("x-ratelimit-remaining"));
  const reset = parseNumber(headers.get("x-ratelimit-reset"));
  const resetAt = reset === undefined ? undefined : new Date(reset * 1000);

  return cleanUndefined({
    limit,
    remaining,
    reset_at: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt.toISOString() : undefined,
  }) as EsaRateLimitInfo;
}

export function fetchPost(options: {
  teamName: string;
  token: string;
  postNumber: number;
  onRateLimit?: (info: EsaRateLimitInfo) => void;
}) {
  return esaGet<EsaPost>({
    teamName: options.teamName,
    path: `/posts/${options.postNumber}`,
    token: options.token,
    cache: EsaCacheMode.NoStore,
    onRateLimit: options.onRateLimit,
  });
}

export function resolveTeamName(inputTeamName: string | undefined, env: Env): string {
  const teamName = inputTeamName?.trim() || env.ESA_DEFAULT_TEAM?.trim();

  if (!teamName) {
    throw inputError("team_name is required.", "Pass team_name or configure ESA_DEFAULT_TEAM.");
  }

  return teamName;
}

export function resolveValidationPostNumber(env: Env): number | undefined {
  const value = env.ESA_VALIDATION_POST_NUMBER?.trim();
  if (!value) {
    return undefined;
  }

  const postNumber = Number(value);
  if (!Number.isInteger(postNumber) || postNumber <= 0) {
    throw serverConfigError("ESA_VALIDATION_POST_NUMBER must be a positive integer.");
  }

  return postNumber;
}

export function resolveContextEntryPostNumber(inputPostNumber: number | undefined, env: Env): number {
  const rawValue = inputPostNumber ?? (env.ESA_CONTEXT_ENTRY_POST_NUMBER ? Number(env.ESA_CONTEXT_ENTRY_POST_NUMBER) : undefined);

  if (!rawValue || !Number.isInteger(rawValue) || rawValue <= 0) {
    throw inputError("entry_post_number is required.", "Pass entry_post_number or configure ESA_CONTEXT_ENTRY_POST_NUMBER.");
  }

  return rawValue;
}

export function resolveContextSummaryPostNumber(inputPostNumber: number | undefined, env: Env): number | undefined {
  const configuredValue = env.ESA_CONTEXT_SUMMARY_POST_NUMBER?.trim();
  const rawValue = inputPostNumber ?? (configuredValue ? Number(configuredValue) : undefined);
  if (rawValue === undefined) {
    return undefined;
  }
  if (!Number.isInteger(rawValue) || rawValue <= 0) {
    throw inputError("summary_post_number must be a positive integer.", "Pass a positive summary_post_number or fix ESA_CONTEXT_SUMMARY_POST_NUMBER.");
  }
  return rawValue;
}

export function resolveContextObserverPostNumber(inputPostNumber: number | undefined, env: Env): number | undefined {
  const rawValue = inputPostNumber ?? (env.ESA_CONTEXT_OBSERVER_POST_NUMBER ? Number(env.ESA_CONTEXT_OBSERVER_POST_NUMBER) : undefined);

  if (rawValue === undefined) {
    return undefined;
  }
  if (!Number.isInteger(rawValue) || rawValue <= 0) {
    throw inputError("observer_post_number must be a positive integer.", "Fix observer_post_number or ESA_CONTEXT_OBSERVER_POST_NUMBER.");
  }

  return rawValue;
}

export function describeEsaValidationTarget(env: Env): string {
  const teamName = resolveTeamName(undefined, env);
  const postNumber = resolveValidationPostNumber(env);
  return postNumber ? `${teamName}の#${postNumber}` : `${teamName}の記事一覧`;
}

export function firstPostNumber(command: string): number | undefined {
  const match = command.match(/#?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export function requireWriteConfirmation(confirmWrite: boolean) {
  if (confirmWrite !== true) {
    throw writeConfirmationError();
  }
}

export function cleanUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function compactUpdatedPost(post: EsaPost) {
  return cleanUndefined({
    number: post.number,
    title: post.name,
    full_name: post.full_name,
    url: post.url,
    updated_at: post.updated_at,
    revision_number: post.revision_number,
    context_version: extractContextVersion(post.body_md),
  });
}
