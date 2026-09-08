import { ContextChangeStatus, ContextObserverSchema, ObserverReadMode } from "../core/constants";
import { DomainStatus, inputError } from "../core/errors";
import type { Env } from "../core/types";
import { safeJsonParse } from "../core/utils";
import {
  readContextObserverManifest,
  requireContextObserverManifest,
  writeContextObserverManifest,
  type ContextObserverManifest,
  type ObservedPost,
  type ObservedPostState,
} from "../state/context-observer";
import { cleanUndefined, fetchPost } from "./esa-api";
import { extractContextVersion } from "./esa-sections";

function extractJsonCodeBlock(body: string) {
  const match = body.match(/```json\s*([\s\S]*?)```/i);
  if (!match) {
    throw inputError("Context observer post must contain a JSON code block.", "Add a ```json baseline block to the observer post.", DomainStatus.ObserverJsonMissing);
  }
  return match[1].trim();
}

function parseContextObserverManifest(body: string): ContextObserverManifest {
  const parsed = safeJsonParse(extractJsonCodeBlock(body));
  const schema = (parsed as { schema?: unknown } | undefined)?.schema;

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (schema !== ContextObserverSchema.ObserverV1 && schema !== ContextObserverSchema.UpdateCheckV1) ||
    !Array.isArray((parsed as { observed_posts?: unknown }).observed_posts)
  ) {
    throw inputError("Context observer JSON is invalid.", "Check the observer baseline JSON format.", DomainStatus.ObserverJsonInvalid);
  }

  return parsed as ContextObserverManifest;
}

async function readPostState(options: { teamName: string; token: string; postNumber: number }): Promise<ObservedPostState> {
  const post = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber });

  return cleanUndefined({
    post_number: post.number ?? options.postNumber,
    title: post.name,
    updated_at: post.updated_at,
    revision_number: post.revision_number,
    context_version: extractContextVersion(post.body_md),
  }) as ObservedPostState;
}

function compactObservedPostState(state: ObservedPostState) {
  return cleanUndefined({
    post_number: state.post_number,
    revision_number: state.revision_number,
    updated_at: state.updated_at,
    context_version: state.context_version,
  });
}

async function importLegacyContextObserver(options: {
  env: Env;
  teamName: string;
  token: string;
  observerPostNumber?: number;
}) {
  const stored = await readContextObserverManifest(options.env, options.teamName);
  if (stored) {
    return stored;
  }
  if (!options.observerPostNumber) {
    return requireContextObserverManifest(options.env, options.teamName);
  }

  const post = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.observerPostNumber });

  const legacy = parseContextObserverManifest(post.body_md ?? "");
  return writeContextObserverManifest(options.env, options.teamName, {
    ...legacy,
    schema: ContextObserverSchema.KvV1,
    team_name: options.teamName,
  });
}

export async function checkContextDrift(options: {
  env: Env;
  teamName: string;
  token: string;
  includeUnchanged?: boolean;
}) {
  const observer = await requireContextObserverManifest(options.env, options.teamName);
  const checks = await Promise.all(
    observer.observed_posts.map(async (observed) => {
      const current = await readPostState({
        teamName: options.teamName,
        token: options.token,
        postNumber: observed.post_number,
      });
      const changes = cleanUndefined({
        revision_number:
          observed.last_seen_revision_number !== undefined && current.revision_number !== observed.last_seen_revision_number
            ? { was: observed.last_seen_revision_number, now: current.revision_number }
            : undefined,
        updated_at:
          observed.last_seen_updated_at !== undefined && current.updated_at !== observed.last_seen_updated_at
            ? { was: observed.last_seen_updated_at, now: current.updated_at }
            : undefined,
        context_version:
          observed.expected_context_version !== undefined && current.context_version !== observed.expected_context_version
            ? { was: observed.expected_context_version, now: current.context_version }
            : undefined,
      });
      const changed = Object.keys(changes).length > 0;

      return cleanUndefined({
        post_number: observed.post_number,
        role: observed.role,
        status: changed ? ContextChangeStatus.Changed : ContextChangeStatus.Unchanged,
        current: compactObservedPostState(current),
        changes: changed ? changes : undefined,
        recommended_read: changed ? observed.recommended_read ?? ObserverReadMode.Outline : undefined,
        recommended_sections: changed ? observed.recommended_sections : undefined,
      });
    }),
  );
  const visibleChecks = options.includeUnchanged
    ? checks
    : checks.filter((check) => check.status === ContextChangeStatus.Changed);
  const changedCount = checks.filter((check) => check.status === ContextChangeStatus.Changed).length;

  return cleanUndefined({
    status: changedCount > 0 ? ContextChangeStatus.Changed : ContextChangeStatus.Unchanged,
    changed_count: changedCount,
    observer: {
      storage: "cloudflare_kv",
      schema: observer.schema,
      team_name: observer.team_name,
      updated_at: observer.updated_at,
    },
    checks: visibleChecks,
  });
}

export async function refreshContextObserver(options: {
  env: Env;
  teamName: string;
  token: string;
  observerPostNumber?: number;
  postNumbers?: number[];
}) {
  const observer = await importLegacyContextObserver(options);
  const targetPostNumbers = new Set(options.postNumbers ?? observer.observed_posts.map((post) => post.post_number));
  const nextObservedPosts = await Promise.all(
    observer.observed_posts.map(async (observed) => {
      if (!targetPostNumbers.has(observed.post_number)) {
        return observed;
      }

      const current = await readPostState({
        teamName: options.teamName,
        token: options.token,
        postNumber: observed.post_number,
      });

      return cleanUndefined({
        ...observed,
        title: current.title,
        last_seen_revision_number: current.revision_number,
        last_seen_updated_at: current.updated_at,
        expected_context_version: current.context_version,
      }) as ObservedPost;
    }),
  );
  const nextManifest: ContextObserverManifest = {
    ...observer,
    schema: ContextObserverSchema.KvV1,
    team_name: options.teamName,
    observed_posts: nextObservedPosts,
  };
  const stored = await writeContextObserverManifest(options.env, options.teamName, nextManifest);
  return cleanUndefined({
    storage: "cloudflare_kv",
    schema: stored.schema,
    team_name: stored.team_name,
    updated_at: stored.updated_at,
    observed_count: stored.observed_posts.length,
    refreshed_count: stored.observed_posts.filter((post) => targetPostNumbers.has(post.post_number)).length,
  });
}
