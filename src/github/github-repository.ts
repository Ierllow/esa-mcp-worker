import { GithubTreeEntryType } from "../core/constants";
import { inputError } from "../core/errors";
import type { Env } from "../core/types";
import { getCommit, getFile, githubRequest } from "./github-api";
import {
  REPOSITORY_CHANGE_MAX_COUNT,
  REPOSITORY_READ_MAX_TOTAL_CHARS,
  REPOSITORY_SNAPSHOT_MAX_FILES,
  normalizeRepositoryPath,
  repositoryPath,
  resolveGithubConfig,
  validateRef,
  type GithubTreeEntry,
} from "./github-common";

export async function getRepositorySnapshot(options: {
  env: Env;
  token: string;
  ref?: string;
}) {
  const config = resolveGithubConfig(options.env);
  const ref = options.ref?.trim() || config.defaultBranch;
  validateRef(ref);
  const commit = await getCommit(config, options.token, ref);
  const tree = await githubRequest<{
    sha: string;
    truncated: boolean;
    tree: GithubTreeEntry[];
  }>(config, options.token, `${repositoryPath(config)}/git/trees/${encodeURIComponent(commit.treeSha)}?recursive=1`);

  return {
    repository: config.fullName,
    ref,
    base_sha: commit.sha,
    tree_sha: tree.sha,
    truncated: tree.truncated,
    files_truncated: tree.truncated || tree.tree.filter((entry) => entry.type === GithubTreeEntryType.Blob).length > REPOSITORY_SNAPSHOT_MAX_FILES,
    files: tree.tree
      .filter((entry) => entry.type === GithubTreeEntryType.Blob)
      .slice(0, REPOSITORY_SNAPSHOT_MAX_FILES)
      .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size, mode: entry.mode })),
  };
}

export async function readRepositoryFiles(options: {
  env: Env;
  token: string;
  ref?: string;
  files: Array<{ path: string; start_line?: number; end_line?: number }>;
}) {
  const config = resolveGithubConfig(options.env);
  const ref = options.ref?.trim() || config.defaultBranch;
  validateRef(ref);
  if (options.files.length === 0 || options.files.length > REPOSITORY_CHANGE_MAX_COUNT) {
    throw inputError(`files must contain 1 to ${REPOSITORY_CHANGE_MAX_COUNT} entries.`);
  }

  const requestedPaths = new Set<string>();
  const requestedFiles = options.files.map((file) => {
    const path = normalizeRepositoryPath(file.path);
    if (requestedPaths.has(path)) {
      throw inputError(`Duplicate repository path: ${path}`);
    }
    requestedPaths.add(path);
    if ((file.start_line ?? 1) < 1 || (file.end_line !== undefined && file.end_line < (file.start_line ?? 1))) {
      throw inputError("File line ranges must be positive and ordered.");
    }
    return { file, path };
  });
  const loadedFiles = await Promise.all(requestedFiles.map(async ({ file, path }) => {
    const value = await getFile(config, options.token, path, ref);
    return { file, path, value };
  }));
  let remainingChars = REPOSITORY_READ_MAX_TOTAL_CHARS;
  const values = [];
  for (const { file, path, value } of loadedFiles) {
    const lines = value.content.split("\n");
    const startLine = file.start_line ?? 1;
    const requestedEndLine = file.end_line ?? lines.length;
    const selected = lines.slice(startLine - 1, requestedEndLine).join("\n");
    const content = selected.slice(0, remainingChars);
    remainingChars -= content.length;
    values.push({
      path,
      sha: value.sha,
      size: value.size,
      start_line: startLine,
      end_line: startLine + Math.max(0, content.split("\n").length - 1),
      content,
      truncated: content.length < selected.length,
    });
    if (remainingChars === 0) {
      break;
    }
  }

  return { repository: config.fullName, ref, files: values };
}
