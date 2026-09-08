import { CONTEXT_OBSERVER_PREFIX, ContextObserverSchema, type ObserverReadMode } from "../core/constants";
import { DomainStatus, domainError, serverConfigError } from "../core/errors";
import type { Env } from "../core/types";

export type ObservedPost = {
  post_number: number;
  role?: string;
  title?: string;
  last_seen_revision_number?: number;
  last_seen_updated_at?: string;
  expected_context_version?: string;
  recommended_read?: ObserverReadMode;
  recommended_sections?: string[];
};

export type ContextObserverManifest = {
  schema: ContextObserverSchema;
  context_version?: string;
  updated_at?: string;
  team_name?: string;
  observed_posts: ObservedPost[];
};

export type ObservedPostState = {
  post_number: number;
  title?: string;
  updated_at?: string;
  revision_number?: number;
  context_version?: string;
};

function observerKey(teamName: string) {
  return `${CONTEXT_OBSERVER_PREFIX}${teamName.trim().toLowerCase()}`;
}

function requireConfigKv(env: Env) {
  if (!env.MCP_CONFIG) {
    throw serverConfigError("MCP_CONFIG KV namespace is not configured.");
  }
  return env.MCP_CONFIG;
}

function isObservedPost(value: unknown): value is ObservedPost {
  return Boolean(
    value &&
    typeof value === "object" &&
    Number.isInteger((value as { post_number?: unknown }).post_number) &&
    Number((value as { post_number?: unknown }).post_number) > 0,
  );
}

function normalizeManifest(value: unknown, teamName: string): ContextObserverManifest | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const manifest = value as Partial<ContextObserverManifest>;
  if (!Array.isArray(manifest.observed_posts) || !manifest.observed_posts.every(isObservedPost)) {
    return undefined;
  }
  return {
    ...manifest,
    schema: ContextObserverSchema.KvV1,
    team_name: teamName,
    observed_posts: manifest.observed_posts,
  };
}

export async function readContextObserverManifest(env: Env, teamName: string) {
  const value = await requireConfigKv(env).get<ContextObserverManifest>(observerKey(teamName), "json");
  if (!value) {
    return undefined;
  }
  const manifest = normalizeManifest(value, teamName);
  if (!manifest) {
    throw domainError(
      "The context observer data in KV is invalid.",
      DomainStatus.ObserverJsonInvalid,
      "Open the admin page and repair or re-import the context observer configuration.",
    );
  }
  return manifest;
}

export async function writeContextObserverManifest(env: Env, teamName: string, manifest: ContextObserverManifest) {
  const value: ContextObserverManifest = {
    ...manifest,
    schema: ContextObserverSchema.KvV1,
    team_name: teamName,
    updated_at: new Date().toISOString(),
    observed_posts: [...manifest.observed_posts].sort((a, b) => a.post_number - b.post_number),
  };
  await requireConfigKv(env).put(observerKey(teamName), JSON.stringify(value));
  return value;
}

export async function requireContextObserverManifest(env: Env, teamName: string) {
  const manifest = await readContextObserverManifest(env, teamName);
  if (!manifest) {
    throw domainError(
      "The context observer is not configured in KV.",
      DomainStatus.ObserverRequired,
      "Import the legacy observer once with esa_refresh_context_observer or add monitored posts from the admin page.",
    );
  }
  return manifest;
}

export async function upsertObservedPost(
  env: Env,
  teamName: string,
  input: Pick<ObservedPost, "post_number"> & Partial<Omit<ObservedPost, "post_number">>,
) {
  const manifest = await readContextObserverManifest(env, teamName) ?? {
    schema: ContextObserverSchema.KvV1,
    team_name: teamName,
    observed_posts: [],
  };
  const existing = manifest.observed_posts.find((post) => post.post_number === input.post_number);
  const observedPost = {
    ...existing,
    ...input,
    recommended_sections: input.recommended_sections?.filter(Boolean) ?? existing?.recommended_sections,
  };
  manifest.observed_posts = existing
    ? manifest.observed_posts.map((post) => post.post_number === input.post_number ? observedPost : post)
    : [...manifest.observed_posts, observedPost];
  return writeContextObserverManifest(env, teamName, manifest);
}

export async function removeObservedPost(env: Env, teamName: string, postNumber: number) {
  const manifest = await requireContextObserverManifest(env, teamName);
  manifest.observed_posts = manifest.observed_posts.filter((post) => post.post_number !== postNumber);
  return writeContextObserverManifest(env, teamName, manifest);
}

export async function syncObservedPostBaselines(env: Env, teamName: string, states: ObservedPostState[]) {
  const manifest = await readContextObserverManifest(env, teamName);
  if (!manifest || states.length === 0) {
    return { updated: 0 };
  }

  const stateByPostNumber = new Map(states.map((state) => [state.post_number, state]));
  let updated = 0;
  manifest.observed_posts = manifest.observed_posts.map((observed) => {
    const current = stateByPostNumber.get(observed.post_number);
    if (!current) {
      return observed;
    }
    updated += 1;
    return {
      ...observed,
      title: current.title ?? observed.title,
      last_seen_revision_number: current.revision_number ?? observed.last_seen_revision_number,
      last_seen_updated_at: current.updated_at ?? observed.last_seen_updated_at,
      expected_context_version: current.context_version ?? observed.expected_context_version,
    };
  });

  if (updated > 0) {
    await writeContextObserverManifest(env, teamName, manifest);
  }
  return { updated };
}
