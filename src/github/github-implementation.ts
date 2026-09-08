import { GithubTreeEntryType, HttpMethod, RepositoryChangeOperation, RepositoryValidationStatus } from "../core/constants";
import { DomainStatus, ErrorSource, ToolError, inputError, normalizeToolError } from "../core/errors";
import type { Env } from "../core/types";
import type { ImplementationReview } from "./github-implementation-review";
import { getBranchHead, getGitCommit, githubRequest } from "./github-api";
import {
  PROTECTED_PATH_PATTERNS,
  REPOSITORY_CHANGE_MAX_COUNT,
  REPOSITORY_CHANGE_MAX_FILE_BYTES,
  REPOSITORY_CHANGE_MAX_TOTAL_BYTES,
  conflictError,
  encodeRef,
  normalizeRepositoryPath,
  payloadTooLarge,
  repositoryPath,
  resolveGithubConfig,
  resourceNotFound,
  validateRef,
  type GithubConfig,
  type GithubTreeEntry,
  type RepositoryChange,
} from "./github-common";
import { readValidationStatus, validationNextAction } from "./github-validation";

export async function createImplementationBranch(options: {
  env: Env;
  token: string;
  expectedBaseSha: string;
  branchSlug: string;
  branch?: string;
  expectedBranchHeadSha?: string;
  commitTitle: string;
  sourceEsaPosts: number[];
  review: ImplementationReview;
  changes: RepositoryChange[];
}) {
  const config = resolveGithubConfig(options.env);
  validateChanges(options.changes);
  const commitMessage = normalizeCommitTitle(options.commitTitle);
  const reusingBranch = options.branch !== undefined || options.expectedBranchHeadSha !== undefined;
  if (reusingBranch && (!options.branch || !options.expectedBranchHeadSha)) {
    throw inputError("branch and expected_branch_head_sha must be provided together.");
  }
  if (options.branch) {
    assertManagedBranch(config, options.branch);
  }

  const [currentHead, currentBranchHead] = await Promise.all([
    getBranchHead(config, options.token, config.defaultBranch),
    options.branch ? getBranchHead(config, options.token, options.branch) : Promise.resolve(undefined),
  ]);
  if (currentHead !== options.expectedBaseSha) {
    throw conflictError(
      DomainStatus.GithubPublishConflict,
      "The default branch changed after the implementation was read.",
      { expected_base_sha: options.expectedBaseSha, actual_base_sha: currentHead },
    );
  }
  if (options.expectedBranchHeadSha && currentBranchHead !== options.expectedBranchHeadSha) {
    throw conflictError(DomainStatus.GithubFileConflict, "The implementation branch changed before correction.", {
      expected_head_sha: options.expectedBranchHeadSha,
      actual_head_sha: currentBranchHead,
    });
  }

  const baseCommit = await getGitCommit(config, options.token, currentHead);
  const baseTree = await githubRequest<{ truncated: boolean; tree: GithubTreeEntry[] }>(
    config,
    options.token,
    `${repositoryPath(config)}/git/trees/${encodeURIComponent(baseCommit.tree.sha)}?recursive=1`,
  );
  if (baseTree.truncated) {
    throw new ToolError({
      source: ErrorSource.GithubApi,
      domainStatus: DomainStatus.GithubPayloadTooLarge,
      message: "The repository tree is too large for a safe atomic update.",
    });
  }
  const currentFiles = new Map(
    baseTree.tree.filter((entry) => entry.type === GithubTreeEntryType.Blob).map((entry) => [entry.path, entry]),
  );

  const tree = options.changes.map((change) => {
    const path = normalizeRepositoryPath(change.path);
    const current = currentFiles.get(path);
    if (change.operation === RepositoryChangeOperation.Delete) {
      assertExpectedBlob(path, current?.sha, change.expected_blob_sha, true);
      return { path, mode: current!.mode, type: GithubTreeEntryType.Blob, sha: null };
    }

    assertExpectedBlob(path, current?.sha, change.expected_blob_sha, Boolean(current));
    return {
      path,
      mode: current?.mode ?? "100644",
      type: GithubTreeEntryType.Blob,
      content: change.content!,
    };
  });

  const createdTree = await githubRequest<{ sha: string }>(config, options.token, `${repositoryPath(config)}/git/trees`, {
    method: HttpMethod.Post,
    body: { base_tree: baseCommit.tree.sha, tree },
  });
  const commit = await githubRequest<{ sha: string; html_url: string }>(
    config,
    options.token,
    `${repositoryPath(config)}/git/commits`,
    { method: HttpMethod.Post, body: { message: commitMessage, tree: createdTree.sha, parents: [currentHead] } },
  );
  const branch = options.branch ?? `${config.branchPrefix}${timestampSlug()}-${normalizeBranchSlug(options.branchSlug)}`;
  if (options.branch) {
    await githubRequest(config, options.token, `${repositoryPath(config)}/git/refs/heads/${encodeRef(branch)}`, {
      method: HttpMethod.Patch,
      body: { sha: commit.sha, force: true },
    });
  } else {
    await githubRequest(config, options.token, `${repositoryPath(config)}/git/refs`, {
      method: HttpMethod.Post,
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }

  return {
    repository: config.fullName,
    base_branch: config.defaultBranch,
    base_sha: currentHead,
    branch,
    branch_reused: Boolean(options.branch),
    head_sha: commit.sha,
    commit_url: commit.html_url,
    changed_paths: tree.map((entry) => entry.path),
    next_action: "Wait for repository checks, then publish only when validation_status is ready.",
  };
}

export async function getImplementationStatus(options: {
  env: Env;
  token: string;
  branch: string;
  expectedHeadSha: string;
  waitSeconds?: number;
}) {
  const config = resolveGithubConfig(options.env);
  assertManagedBranch(config, options.branch);
  const waitMilliseconds = Math.min(Math.max(options.waitSeconds ?? 0, 0), 50) * 1000;
  const deadline = Date.now() + waitMilliseconds;

  while (true) {
    const branchHead = await getBranchHead(config, options.token, options.branch);
    if (branchHead !== options.expectedHeadSha) {
      throw conflictError(DomainStatus.GithubFileConflict, "The implementation branch head changed.", {
        expected_head_sha: options.expectedHeadSha,
        actual_head_sha: branchHead,
      });
    }
    const status = await readValidationStatus(config, options.token, branchHead);
    if (
      status.validation_status === RepositoryValidationStatus.Ready ||
      status.validation_status === RepositoryValidationStatus.Failed ||
      Date.now() >= deadline
    ) {
      return {
        repository: config.fullName,
        branch: options.branch,
        head_sha: branchHead,
        ...status,
        needs_follow_up: status.validation_status !== RepositoryValidationStatus.Ready,
        next_action: validationNextAction(status.validation_status),
      };
    }
    await delay(2_000);
  }
}

export async function publishImplementation(options: {
  env: Env;
  token: string;
  branch: string;
  expectedBaseSha: string;
  expectedHeadSha: string;
}) {
  const config = resolveGithubConfig(options.env);
  assertManagedBranch(config, options.branch);
  const [baseHead, branchHead] = await Promise.all([
    getBranchHead(config, options.token, config.defaultBranch),
    getBranchHead(config, options.token, options.branch),
  ]);
  const alreadyPublished = baseHead === options.expectedHeadSha && branchHead === options.expectedHeadSha;
  if (!alreadyPublished && (baseHead !== options.expectedBaseSha || branchHead !== options.expectedHeadSha)) {
    throw conflictError(DomainStatus.GithubPublishConflict, "A repository reference changed before publication.", {
      expected_base_sha: options.expectedBaseSha,
      actual_base_sha: baseHead,
      expected_head_sha: options.expectedHeadSha,
      actual_head_sha: branchHead,
    });
  }

  const validation = await readValidationStatus(config, options.token, branchHead);
  if (validation.validation_status !== RepositoryValidationStatus.Ready) {
    const domainStatus = validation.validation_status === RepositoryValidationStatus.Failed
      ? DomainStatus.GithubValidationFailed
      : validation.validation_status === RepositoryValidationStatus.Pending
        ? DomainStatus.GithubValidationPending
        : DomainStatus.GithubValidationMissing;
    throw new ToolError({
      source: ErrorSource.GithubApi,
      domainStatus,
      message: `Repository validation is ${validation.validation_status}.`,
      details: validation,
    });
  }

  if (!alreadyPublished) {
    await githubRequest(config, options.token, `${repositoryPath(config)}/git/refs/heads/${encodeRef(config.defaultBranch)}`, {
      method: HttpMethod.Patch,
      body: { sha: branchHead, force: false },
    });
  }

  let temporaryBranchDeleted = true;
  let cleanupError: { domain_status: string; message_ja: string } | undefined;
  try {
    await githubRequest(config, options.token, `${repositoryPath(config)}/git/refs/heads/${encodeRef(options.branch)}`, {
      method: HttpMethod.Delete,
    });
  } catch (error) {
    temporaryBranchDeleted = false;
    const normalized = normalizeToolError(error);
    cleanupError = {
      domain_status: normalized.domain_status,
      message_ja: normalized.message_ja,
    };
  }

  return {
    repository: config.fullName,
    branch: config.defaultBranch,
    head_sha: branchHead,
    validation_status: validation.validation_status,
    published: true,
    default_branch_updated: !alreadyPublished,
    already_published: alreadyPublished,
    temporary_branch_deleted: temporaryBranchDeleted,
    cleanup_error: cleanupError,
    next_action: temporaryBranchDeleted
      ? "No follow-up is required."
      : "Call repo_publish_implementation again with the same values to retry temporary branch cleanup.",
    deployment_trigger_expected: !alreadyPublished,
  };
}

function validateChanges(changes: RepositoryChange[]) {
  if (changes.length === 0 || changes.length > REPOSITORY_CHANGE_MAX_COUNT) {
    throw new ToolError({
      source: ErrorSource.Input,
      domainStatus: DomainStatus.GithubPayloadTooLarge,
      message: `changes must contain 1 to ${REPOSITORY_CHANGE_MAX_COUNT} entries.`,
    });
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const change of changes) {
    const path = normalizeRepositoryPath(change.path);
    if (paths.has(path)) {
      throw inputError(`Duplicate repository path: ${path}`);
    }
    paths.add(path);
    if (PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      throw new ToolError({
        source: ErrorSource.Input,
        domainStatus: DomainStatus.GithubProtectedPath,
        message: `Automatic updates are blocked for ${path}.`,
      });
    }
    if (change.operation === RepositoryChangeOperation.Upsert) {
      if (typeof change.content !== "string") {
        throw inputError(`content is required for ${path}.`);
      }
      const bytes = new TextEncoder().encode(change.content).byteLength;
      if (bytes > REPOSITORY_CHANGE_MAX_FILE_BYTES) {
        throw payloadTooLarge(path);
      }
      totalBytes += bytes;
    } else if (!change.expected_blob_sha) {
      throw inputError(`expected_blob_sha is required when deleting ${path}.`);
    }
  }
  if (totalBytes > REPOSITORY_CHANGE_MAX_TOTAL_BYTES) {
    throw payloadTooLarge();
  }
}

function assertExpectedBlob(path: string, actualSha: string | undefined, expectedSha: string | undefined, mustExist: boolean) {
  if (mustExist && !actualSha) {
    throw resourceNotFound(`Repository file not found: ${path}`);
  }
  if (actualSha !== expectedSha) {
    throw conflictError(DomainStatus.GithubFileConflict, `Repository file changed: ${path}`, {
      path,
      expected_blob_sha: expectedSha,
      actual_blob_sha: actualSha,
    });
  }
}

function normalizeBranchSlug(value: string) {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!slug) {
    throw inputError("branch_slug must contain a letter or number.");
  }
  return slug;
}

function normalizeCommitTitle(value: string) {
  const title = value.trim();
  if (!title || title.length > 72 || /[\r\n]/.test(title)) {
    throw inputError("commit_title must be one non-empty line of at most 72 characters.");
  }
  return title;
}

function assertManagedBranch(config: GithubConfig, branch: string) {
  validateRef(branch);
  if (!branch.startsWith(config.branchPrefix)) {
    throw inputError(`branch must start with the configured prefix ${config.branchPrefix}.`);
  }
}

function timestampSlug() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  return `${timestamp}-${crypto.randomUUID().slice(0, 6)}`;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
