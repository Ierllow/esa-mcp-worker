import { EsaCacheMode, EsaRequestAccess } from "../core/constants";
import { bytesToBase64Url } from "../core/crypto";
import type { EsaRequestOptions } from "../core/types";

const DEFAULT_POST_CACHE_TTL_SECONDS = 5 * 60;
const DEFAULT_POST_CACHE_MAX_ENTRIES = 100;

type PostCacheEntry = {
  teamName: string;
  postNumber: number;
  value: unknown;
  expiresAt: number;
  lastAccessedAt: number;
};

const postCache = new Map<string, PostCacheEntry>();
const inFlightPostReads = new Map<string, Promise<unknown>>();
const postCacheGenerations = new Map<string, number>();
const teamCacheGenerations = new Map<string, number>();

function postIdentity(teamName: string, postNumber: number) {
  return `${teamName}|${postNumber}`;
}

function postGeneration(teamName: string, postNumber: number) {
  return postCacheGenerations.get(postIdentity(teamName, postNumber)) ?? 0;
}

function bumpPostGeneration(teamName: string, postNumber: number) {
  const identity = postIdentity(teamName, postNumber);
  postCacheGenerations.set(identity, (postCacheGenerations.get(identity) ?? 0) + 1);
}

function teamGeneration(teamName: string) {
  return teamCacheGenerations.get(teamName) ?? 0;
}

function normalizedSearchParams(searchParams: EsaRequestOptions["searchParams"]) {
  return Object.entries(searchParams ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function tokenFingerprint(token: string) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))).slice(0, 24);
}

async function cacheKey(options: EsaRequestOptions) {
  return [
    await tokenFingerprint(options.token),
    options.teamName,
    options.path,
    normalizedSearchParams(options.searchParams),
  ].join("|");
}

function pruneExpiredEntries(now: number) {
  for (const [key, entry] of postCache) {
    if (entry.expiresAt <= now) {
      postCache.delete(key);
    }
  }
}

function pruneLruEntries(maxEntries: number) {
  while (postCache.size > maxEntries) {
    let oldestKey: string | undefined;
    let oldestAccess = Infinity;
    for (const [key, entry] of postCache) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestKey = key;
        oldestAccess = entry.lastAccessedAt;
      }
    }
    if (!oldestKey) {
      return;
    }
    postCache.delete(oldestKey);
  }
}

export async function readCachedPost<T>(options: EsaRequestOptions, load: () => Promise<T>) {
  const postNumber = Number(/^\/posts\/(\d+)$/.exec(options.path)?.[1]);
  if (
    options.cache === EsaCacheMode.NoStore ||
    options.access !== EsaRequestAccess.Read ||
    !postNumber ||
    DEFAULT_POST_CACHE_TTL_SECONDS === 0
  ) {
    return load();
  }

  const now = Date.now();
  pruneExpiredEntries(now);
  const key = await cacheKey(options);
  const cached = postCache.get(key);
  if (cached && cached.expiresAt > now) {
    cached.lastAccessedAt = now;
    return cached.value as T;
  }

  const inFlight = inFlightPostReads.get(key);
  if (inFlight) {
    return inFlight as Promise<T>;
  }

  const generation = postGeneration(options.teamName, postNumber);
  const currentTeamGeneration = teamGeneration(options.teamName);
  const pending = load().then((value) => {
    const loadedAt = Date.now();
    if (
      postGeneration(options.teamName, postNumber) === generation &&
      teamGeneration(options.teamName) === currentTeamGeneration
    ) {
      postCache.set(key, {
        teamName: options.teamName,
        postNumber,
        value,
        expiresAt: loadedAt + DEFAULT_POST_CACHE_TTL_SECONDS * 1000,
        lastAccessedAt: loadedAt,
      });
      pruneLruEntries(DEFAULT_POST_CACHE_MAX_ENTRIES);
    }
    return value;
  }).finally(() => {
    inFlightPostReads.delete(key);
  });
  inFlightPostReads.set(key, pending);
  return pending;
}

export function invalidatePostCache(teamName: string, postNumber: number) {
  bumpPostGeneration(teamName, postNumber);
  for (const [key, entry] of postCache) {
    if (entry.teamName === teamName && entry.postNumber === postNumber) {
      postCache.delete(key);
    }
  }
  for (const key of inFlightPostReads.keys()) {
    if (key.includes(`|${teamName}|/posts/${postNumber}|`)) {
      inFlightPostReads.delete(key);
    }
  }
}

export function invalidateTeamPostCache(teamName: string) {
  teamCacheGenerations.set(teamName, teamGeneration(teamName) + 1);
  for (const [key, entry] of postCache) {
    if (entry.teamName === teamName) {
      postCache.delete(key);
    }
  }
  for (const key of inFlightPostReads.keys()) {
    if (key.includes(`|${teamName}|/posts/`)) {
      inFlightPostReads.delete(key);
    }
  }
}
