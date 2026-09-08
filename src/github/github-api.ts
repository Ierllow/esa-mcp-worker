import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GithubContentEncoding,
  GithubContentType,
  HttpMethod,
  HttpStatusCode,
} from "../core/constants";
import { DomainStatus, ErrorSource, ToolError } from "../core/errors";
import { encodeRef, repositoryPath, resourceNotFound, type GithubConfig } from "./github-common";

export async function getFile(config: GithubConfig, token: string, path: string, ref: string) {
  const value = await githubRequest<{
    type: GithubContentType;
    sha: string;
    size: number;
    encoding: GithubContentEncoding;
    content: string;
  }>(config, token, `${repositoryPath(config)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (value.type !== GithubContentType.File || value.encoding !== GithubContentEncoding.Base64) {
    throw resourceNotFound(`Repository path is not a readable file: ${path}`);
  }
  return { sha: value.sha, size: value.size, content: decodeBase64(value.content) };
}

export async function getCommit(config: GithubConfig, token: string, ref: string) {
  const value = await githubRequest<{ sha: string; commit: { tree: { sha: string } } }>(
    config,
    token,
    `${repositoryPath(config)}/commits/${encodeURIComponent(ref)}`,
  );
  return { sha: value.sha, treeSha: value.commit.tree.sha };
}

export async function getGitCommit(config: GithubConfig, token: string, sha: string) {
  return githubRequest<{ sha: string; tree: { sha: string } }>(
    config,
    token,
    `${repositoryPath(config)}/git/commits/${encodeURIComponent(sha)}`,
  );
}

export async function getBranchHead(config: GithubConfig, token: string, branch: string) {
  const value = await githubRequest<{ object: { sha: string } }>(
    config,
    token,
    `${repositoryPath(config)}/git/ref/heads/${encodeRef(branch)}`,
  );
  return value.object.sha;
}

export async function githubRequest<T>(
  config: GithubConfig,
  token: string,
  path: string,
  options: { method?: HttpMethod; body?: unknown } = {},
) {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    method: options.method ?? HttpMethod.Get,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "esa-mcp-worker",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? parseJson(text) : {};
  if (!response.ok) {
    throw githubApiError(config, response.status, response.statusText, path, body);
  }
  return body as T;
}

function githubStatusDomainStatus(config: GithubConfig, status: number, path: string): DomainStatus {
  switch (status) {
    case HttpStatusCode.Unauthorized:
      return DomainStatus.GithubAuthFailed;
    case HttpStatusCode.Forbidden:
      return DomainStatus.GithubPermissionDenied;
    case HttpStatusCode.NotFound:
      return path === repositoryPath(config) ? DomainStatus.GithubRepositoryNotFound : DomainStatus.GithubResourceNotFound;
    case HttpStatusCode.Conflict:
    case HttpStatusCode.UnprocessableEntity:
      return path.endsWith("/git/refs") ? DomainStatus.GithubRefConflict : DomainStatus.GithubApiFailed;
    default:
      return DomainStatus.GithubApiFailed;
  }
}

function githubApiError(config: GithubConfig, status: number, statusText: string, path: string, body: unknown) {
  return new ToolError({
    source: ErrorSource.GithubApi,
    domainStatus: githubStatusDomainStatus(config, status, path),
    message: `GitHub API request failed: ${status} ${statusText}`,
    status,
    details: { path, response: body },
  });
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { message: value.slice(0, 1_000) };
  }
}
