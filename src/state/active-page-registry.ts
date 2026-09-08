import { parseDocument } from "yaml";
import { z } from "zod";
import {
  ActivePageAutoRead,
  ActivePageFreshness,
  ActivePageRole,
  EsaCacheMode,
  RegistryIssueCode,
  RegistryIssueSeverity,
  RegistryLintStatus,
} from "../core/constants";
import { readContextObserverManifest } from "./context-observer";
import { esaGet, type EsaPost } from "../esa/esa";
import { DomainStatus, inputError, normalizeToolError, serverConfigError } from "../core/errors";
import type { Env } from "../core/types";

const MAX_REGISTRY_YAML_CHARS = 64_000;
const MAX_REGISTRY_PAGES = 50;
const MAX_REGISTRY_TARGETS = 100;

const positivePostNumber = z.number().int().positive();
const registryPageSchema = z.object({
  post: positivePostNumber,
  role: z.enum(ActivePageRole),
  auto_read: z.enum(ActivePageAutoRead),
  freshness: z.array(z.enum(ActivePageFreshness)).min(1),
  successor: positivePostNumber.nullable(),
  routes: z.array(positivePostNumber),
}).strict();

const activePageRegistrySchema = z.object({
  registry_version: z.number().int().positive(),
  scope: z.literal("control_plane"),
  pages: z.array(registryPageSchema).min(1).max(MAX_REGISTRY_PAGES),
}).strict();

export type ActivePageRegistry = z.infer<typeof activePageRegistrySchema>;
type RegistryPage = ActivePageRegistry["pages"][number];

type RegistryIssue = {
  severity: RegistryIssueSeverity;
  code: RegistryIssueCode;
  post_number?: number;
  source_post_number?: number;
  role?: ActivePageRole;
  detail?: string;
};

type TargetState = {
  post_number: number;
  exists: boolean;
  archived?: boolean;
  full_name?: string;
};

function extractYamlBlock(body: string) {
  const match = body.match(/```ya?ml\s*([\s\S]*?)```/i);
  if (!match) {
    throw inputError(
      "Active page registry must contain a YAML code block.",
      "Add one ```yaml registry block to the configured registry post.",
      DomainStatus.RegistryYamlMissing,
    );
  }
  const source = match[1].trim();
  if (!source || source.length > MAX_REGISTRY_YAML_CHARS) {
    throw inputError(
      "Active page registry YAML is empty or too large.",
      `Keep the YAML block between 1 and ${MAX_REGISTRY_YAML_CHARS} characters.`,
      DomainStatus.RegistryYamlInvalid,
    );
  }
  return source;
}

export function parseActivePageRegistry(body: string): ActivePageRegistry {
  const source = extractYamlBlock(body);
  let value: unknown;
  try {
    const document = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw inputError(
      "Active page registry YAML could not be parsed.",
      "Fix the YAML syntax, duplicate keys, or aliases in the registry block.",
      DomainStatus.RegistryYamlInvalid,
    );
  }

  const parsed = activePageRegistrySchema.safeParse(value);
  if (!parsed.success) {
    throw inputError(
      "Active page registry YAML does not match the required schema.",
      "Check registry_version, scope, pages, role, auto_read, freshness, successor, and routes.",
      DomainStatus.RegistryYamlInvalid,
    );
  }
  return parsed.data;
}

export function resolveActivePageRegistryPostNumber(input: number | undefined, env: Env) {
  const raw = input ?? Number(env.ESA_ACTIVE_PAGE_REGISTRY_POST_NUMBER);
  if (!Number.isInteger(raw) || raw <= 0) {
    throw serverConfigError(
      "Active page registry post number is not configured.",
      "Pass registry_post_number or configure ESA_ACTIVE_PAGE_REGISTRY_POST_NUMBER.",
      DomainStatus.RegistryRequired,
    );
  }
  return raw;
}

function duplicateValues<T>(values: T[]) {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function schemaIssues(registry: ActivePageRegistry): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  for (const postNumber of duplicateValues(registry.pages.map((page) => page.post))) {
    issues.push({ severity: RegistryIssueSeverity.Error, code: RegistryIssueCode.DuplicatePost, post_number: postNumber });
  }
  for (const role of duplicateValues(registry.pages.map((page) => page.role))) {
    issues.push({ severity: RegistryIssueSeverity.Error, code: RegistryIssueCode.DuplicateRole, role });
  }

  const entryPages = registry.pages.filter((page) => page.role === ActivePageRole.Entry);
  if (entryPages.length !== 1) {
    issues.push({
      severity: RegistryIssueSeverity.Error,
      code: RegistryIssueCode.EntryCount,
      detail: `Expected one entry page, found ${entryPages.length}.`,
    });
  } else if (entryPages[0].auto_read !== ActivePageAutoRead.Always) {
    issues.push({
      severity: RegistryIssueSeverity.Error,
      code: RegistryIssueCode.EntryAutoRead,
      post_number: entryPages[0].post,
      role: entryPages[0].role,
    });
  }

  for (const page of registry.pages) {
    for (const route of duplicateValues(page.routes)) {
      issues.push({
        severity: RegistryIssueSeverity.Warning,
        code: RegistryIssueCode.DuplicateRoute,
        post_number: route,
        source_post_number: page.post,
      });
    }
    if (
      page.freshness.includes(ActivePageFreshness.Self) &&
      page.role !== ActivePageRole.Freshness
    ) {
      issues.push({
        severity: RegistryIssueSeverity.Warning,
        code: RegistryIssueCode.UnexpectedSelfFreshness,
        post_number: page.post,
        role: page.role,
      });
    }
  }
  return issues;
}

async function readTargetState(teamName: string, token: string, postNumber: number): Promise<TargetState> {
  try {
    const post = await esaGet<EsaPost>({
      teamName,
      path: `/posts/${postNumber}`,
      token,
      cache: EsaCacheMode.NoStore,
    });
    const fullName = post.full_name ?? post.name;
    return {
      post_number: postNumber,
      exists: true,
      archived: /^Archived\//i.test(fullName ?? ""),
      full_name: fullName,
    };
  } catch (error) {
    const normalized = normalizeToolError(error);
    if (
      normalized.domain_status === DomainStatus.EsaPostNotFound ||
      normalized.domain_status === DomainStatus.EsaResourceNotFound
    ) {
      return { post_number: postNumber, exists: false };
    }
    throw error;
  }
}

function targetIssues(registry: ActivePageRegistry, states: Map<number, TargetState>): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const registryPosts = new Set(registry.pages.map((page) => page.post));

  const addTargetIssue = (page: RegistryPage, target: number, relation: "page" | "route" | "successor") => {
    const state = states.get(target);
    if (!state?.exists) {
      issues.push({
        severity: RegistryIssueSeverity.Error,
        code: relation === "page" ? RegistryIssueCode.MissingPost : RegistryIssueCode.MissingTarget,
        post_number: target,
        source_post_number: relation === "page" ? undefined : page.post,
        detail: relation,
      });
      return;
    }
    if (state.archived) {
      issues.push({
        severity: RegistryIssueSeverity.Error,
        code: relation === "page" ? RegistryIssueCode.ArchivedPost : RegistryIssueCode.ArchivedTarget,
        post_number: target,
        source_post_number: relation === "page" ? undefined : page.post,
        detail: state.full_name,
      });
    }
  };

  for (const page of registry.pages) {
    addTargetIssue(page, page.post, "page");
    for (const route of page.routes) {
      addTargetIssue(page, route, "route");
    }
    if (page.successor !== null) {
      addTargetIssue(page, page.successor, "successor");
      for (const source of registry.pages) {
        if (source.routes.includes(page.post)) {
          issues.push({
            severity: RegistryIssueSeverity.Error,
            code: RegistryIssueCode.StaleSuccessorRoute,
            post_number: page.post,
            source_post_number: source.post,
            detail: `Use successor ${page.successor}.`,
          });
        }
      }
    }
  }

  const entry = registry.pages.find((page) => page.role === ActivePageRole.Entry);
  if (entry) {
    const reachable = new Set<number>([entry.post]);
    const queue = [entry.post];
    const pageByPost = new Map(registry.pages.map((page) => [page.post, page]));
    while (queue.length > 0) {
      const page = pageByPost.get(queue.shift()!);
      for (const route of page?.routes ?? []) {
        if (registryPosts.has(route) && !reachable.has(route)) {
          reachable.add(route);
          queue.push(route);
        }
      }
    }
    for (const page of registry.pages) {
      if (!reachable.has(page.post)) {
        issues.push({
          severity: RegistryIssueSeverity.Warning,
          code: RegistryIssueCode.UnreachablePage,
          post_number: page.post,
          role: page.role,
        });
      }
    }
  }
  return issues;
}

export async function lintActivePageRegistry(options: {
  env: Env;
  teamName: string;
  token: string;
  registryPostNumber: number;
}) {
  const registryPost = await esaGet<EsaPost>({
    teamName: options.teamName,
    path: `/posts/${options.registryPostNumber}`,
    token: options.token,
    cache: EsaCacheMode.NoStore,
  });
  const registry = parseActivePageRegistry(registryPost.body_md ?? "");
  const targets = new Set<number>();
  for (const page of registry.pages) {
    targets.add(page.post);
    page.routes.forEach((route) => targets.add(route));
    if (page.successor !== null) {
      targets.add(page.successor);
    }
  }
  if (targets.size > MAX_REGISTRY_TARGETS) {
    throw inputError(
      `Active page registry references ${targets.size} posts, above the ${MAX_REGISTRY_TARGETS} target limit.`,
      "Reduce control-plane pages and routes or split unrelated registry scope.",
      DomainStatus.RegistryYamlInvalid,
    );
  }

  const [targetStates, observer] = await Promise.all([
    Promise.all([...targets].map((postNumber) => readTargetState(options.teamName, options.token, postNumber))),
    readContextObserverManifest(options.env, options.teamName),
  ]);
  const states = new Map(targetStates.map((state) => [state.post_number, state]));
  const issues = [...schemaIssues(registry), ...targetIssues(registry, states)];
  const observedPosts = new Set(observer?.observed_posts.map((post) => post.post_number) ?? []);

  for (const page of registry.pages) {
    if (
      page.freshness.includes(ActivePageFreshness.KvObserver) &&
      !observedPosts.has(page.post)
    ) {
      issues.push({
        severity: RegistryIssueSeverity.Error,
        code: RegistryIssueCode.ObserverMissing,
        post_number: page.post,
        role: page.role,
      });
    }
  }

  const errors = issues.filter((issue) => issue.severity === RegistryIssueSeverity.Error).length;
  const warnings = issues.length - errors;
  return {
    status: issues.length === 0 ? RegistryLintStatus.Valid : RegistryLintStatus.Issues,
    registry: {
      post_number: options.registryPostNumber,
      revision_number: registryPost.revision_number,
      registry_version: registry.registry_version,
      scope: registry.scope,
      page_count: registry.pages.length,
    },
    checked_post_count: targets.size,
    issue_count: issues.length,
    errors,
    warnings,
    issues,
  };
}
