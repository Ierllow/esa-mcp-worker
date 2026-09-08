import { GithubTreeEntryType, HttpStatusCode, RepositoryChangeOperation } from "../core/constants";
import { DomainStatus, ErrorSource, ToolError, inputError, serverConfigError } from "../core/errors";
import type { Env } from "../core/types";

export const REPOSITORY_CHANGE_MAX_COUNT = 12;
export const REPOSITORY_CHANGE_MAX_FILE_BYTES = 160 * 1024;
export const REPOSITORY_CHANGE_MAX_TOTAL_BYTES = 400 * 1024;
export const REPOSITORY_READ_MAX_TOTAL_CHARS = 300_000;
export const REPOSITORY_SNAPSHOT_MAX_FILES = 2_000;

export const PROTECTED_PATH_PATTERNS = [
  /^\.github\/workflows\//i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)$/i,
  /\.(?:key|pem|p12|pfx)$/i,
];

export type GithubConfig = {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  branchPrefix: string;
  requiredCheckNames: string[];
};

export type GithubTreeEntry = {
  path: string;
  mode: string;
  type: GithubTreeEntryType;
  sha: string;
  size?: number;
};

export type RepositoryChange = {
  operation: RepositoryChangeOperation;
  path: string;
  expected_blob_sha?: string;
  content?: string;
};

export function resolveGithubConfig(env: Env): GithubConfig {
  const fullName = env.GITHUB_REPOSITORY?.trim();
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(fullName ?? "");
  if (!match) {
    throw serverConfigError(
      "GITHUB_REPOSITORY must use the owner/repository format.",
      "Configure the target repository in the Cloudflare Worker variables.",
    );
  }

  const defaultBranch = env.GITHUB_DEFAULT_BRANCH?.trim() || "main";
  const configuredPrefix = env.GITHUB_BRANCH_PREFIX?.trim() || "mcp/";
  const branchPrefix = configuredPrefix.endsWith("/") ? configuredPrefix : `${configuredPrefix}/`;
  const requiredCheckNames = (env.GITHUB_REQUIRED_CHECK_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!isSafeRef(defaultBranch) || !isSafeRef(branchPrefix.slice(0, -1))) {
    throw serverConfigError(
      "GitHub branch configuration is invalid.",
      "Use branch names containing only letters, numbers, dots, underscores, hyphens, and slashes.",
    );
  }

  return {
    owner: match[1]!,
    repo: match[2]!,
    fullName: match[0],
    defaultBranch,
    branchPrefix,
    requiredCheckNames,
  };
}

export function normalizeRepositoryPath(value: string) {
  const path = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("..") || path.includes("//")) {
    throw inputError("Repository path is invalid.");
  }
  return path;
}

export function validateRef(ref: string) {
  if (!isSafeRef(ref)) {
    throw inputError("Git reference is invalid.");
  }
}

function isSafeRef(ref: string) {
  return Boolean(ref) && /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes("..") && !ref.includes("//");
}

export function repositoryPath(config: GithubConfig) {
  return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

export function encodeRef(ref: string) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

export function payloadTooLarge(path?: string) {
  return new ToolError({
    source: ErrorSource.Input,
    domainStatus: DomainStatus.GithubPayloadTooLarge,
    message: path ? `Repository file is too large: ${path}` : "Repository update payload is too large.",
  });
}

export function resourceNotFound(message: string) {
  return new ToolError({
    source: ErrorSource.GithubApi,
    domainStatus: DomainStatus.GithubResourceNotFound,
    message,
    status: HttpStatusCode.NotFound,
  });
}

export function conflictError(
  domainStatus: DomainStatus.GithubFileConflict | DomainStatus.GithubPublishConflict,
  message: string,
  details: Record<string, unknown>,
) {
  return new ToolError({
    source: ErrorSource.GithubApi,
    domainStatus,
    message,
    status: HttpStatusCode.Conflict,
    details,
  });
}
