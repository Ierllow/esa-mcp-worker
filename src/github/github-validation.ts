import { GithubCheckRunConclusion, GithubCheckRunStatus, GithubCommitState, RepositoryValidationStatus } from "../core/constants";
import { githubRequest } from "./github-api";
import { repositoryPath, type GithubConfig } from "./github-common";

type GithubCheckRun = {
  id: number;
  name: string;
  status: GithubCheckRunStatus;
  conclusion: GithubCheckRunConclusion | null;
  details_url?: string;
  output?: {
    title?: string | null;
    summary?: string | null;
  };
};

type GithubCommitStatus = {
  context: string;
  state: GithubCommitState;
  description?: string;
  target_url?: string;
};

export async function readValidationStatus(config: GithubConfig, token: string, sha: string) {
  const [checks, combinedStatus] = await Promise.all([
    githubRequest<{ total_count: number; check_runs: GithubCheckRun[] }>(
      config,
      token,
      `${repositoryPath(config)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100`,
    ),
    githubRequest<{ total_count: number; statuses: GithubCommitStatus[] }>(
      config,
      token,
      `${repositoryPath(config)}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
    ),
  ]);
  const checkRuns = checks.check_runs ?? [];
  const statuses = combinedStatus.statuses ?? [];
  const observedCheckNames = new Set(checkRuns.map((check) => check.name));
  const missingRequiredChecks = config.requiredCheckNames.filter((name) => !observedCheckNames.has(name));
  const failed = checkRuns.some((check) => check.status === GithubCheckRunStatus.Completed && !isPassingConclusion(check.conclusion))
    || statuses.some((status) => status.state === GithubCommitState.Failure || status.state === GithubCommitState.Error);
  const pending = checkRuns.some((check) => check.status !== GithubCheckRunStatus.Completed)
    || statuses.some((status) => status.state === GithubCommitState.Pending);
  const total = checkRuns.length + statuses.length;
  const validationStatus = failed
    ? RepositoryValidationStatus.Failed
    : pending
      ? RepositoryValidationStatus.Pending
      : config.requiredCheckNames.length === 0 || total === 0 || missingRequiredChecks.length > 0
        ? RepositoryValidationStatus.Missing
        : RepositoryValidationStatus.Ready;

  return {
    validation_status: validationStatus,
    required_checks: config.requiredCheckNames,
    missing_required_checks: missingRequiredChecks,
    checks: checkRuns.map((check) => ({
      id: check.id,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      details_url: check.details_url,
      output_title: check.output?.title?.slice(0, 500),
      output_summary: check.output?.summary?.slice(0, 4_000),
    })),
    commit_statuses: statuses.map((status) => ({
      name: status.context,
      status: status.state,
      description: status.description,
      details_url: status.target_url,
    })),
  };
}

function isPassingConclusion(conclusion: GithubCheckRunConclusion | null) {
  switch (conclusion) {
    case GithubCheckRunConclusion.Success:
    case GithubCheckRunConclusion.Neutral:
    case GithubCheckRunConclusion.Skipped:
      return true;
    default:
      return false;
  }
}

export function validationNextAction(status: RepositoryValidationStatus) {
  switch (status) {
    case RepositoryValidationStatus.Ready:
      return "Publish the implementation with the same base and head SHAs.";
    case RepositoryValidationStatus.Failed:
      return "Briefly report the failed check, inspect its summary and branch files, then replace the commit on the same branch and revalidate it.";
    case RepositoryValidationStatus.Pending:
      return "Check the same branch and head SHA again.";
    default:
      return "Verify that non-production branch builds and build watch paths are enabled before retrying.";
  }
}
