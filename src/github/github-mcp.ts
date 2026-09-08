import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { OperationStatus } from "../core/constants";
import {
  REPOSITORY_CHANGE_MAX_COUNT,
  createImplementationBranch,
  getImplementationStatus,
  getRepositorySnapshot,
  publishImplementation,
  readRepositoryFiles,
  resolveGithubAccessToken,
} from "./github";
import { type ImplementationReview } from "./github-implementation-review";
import {
  GITHUB_WRITE_META,
  GITHUB_SCHEMAS,
  requireRepositoryWriteConfirmation,
} from "./github-mcp-static";
import {
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
} from "../mcp/mcp-static";
import type { AuditEvent, Env } from "../core/types";
import { createErrorResult, createStructuredResult, createWriteResult } from "../core/utils";

type TrackedToolResult =
  | ReturnType<typeof createStructuredResult>
  | ReturnType<typeof createWriteResult>
  | ReturnType<typeof createErrorResult>;
type ToolTracker = (
  toolName: string,
  details: Partial<AuditEvent>,
  run: () => Promise<TrackedToolResult>,
) => Promise<TrackedToolResult>;

export function registerGithubTools(options: {
  server: McpServer;
  env: Env;
  track: ToolTracker;
}) {
  const { server, env, track } = options;
  const resolveToken = () => resolveGithubAccessToken(env);
  const { shaSchema, implementationReviewSchema, repositoryChangeSchema } = GITHUB_SCHEMAS;
  const repoTool = <S extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    config: {
      title: string;
      description: string;
      annotations: typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;
      _meta?: Record<string, string>;
      inputSchema: S;
    },
    details: (args: z.infer<S>) => Partial<AuditEvent>,
    run: (args: z.infer<S>, token: string) => Promise<TrackedToolResult>,
  ) =>
    server.registerTool(name, config, ((args: z.infer<S>) =>
      track(name, details(args), async () => {
        const confirmWrite = (args as { confirm_write?: boolean }).confirm_write;
        if (confirmWrite !== undefined) {
          requireRepositoryWriteConfirmation(confirmWrite);
        }
        return run(args, await resolveToken());
      })) as never);

  repoTool(
    "repo_get_snapshot",
    {
      title: "Inspect Implementation Repository",
      description:
        "Read the configured repository head and recursive file catalog before assessing implementation impact. Returns paths and blob SHAs without file bodies.",
      annotations: READ_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        ref: z.string().min(1).max(200).optional().describe("Branch or commit to inspect. Defaults to GITHUB_DEFAULT_BRANCH."),
      }),
    },
    () => ({ target: "repository:snapshot" }),
    async ({ ref }, token) =>
      createStructuredResult(await getRepositorySnapshot({ env, token, ref }), "Repository snapshot loaded."),
  );

  repoTool(
    "repo_read_files",
    {
      title: "Read Implementation Files",
      description:
        "Read selected UTF-8 repository files in one call. Use the blob SHAs as optimistic concurrency guards when preparing changes.",
      annotations: READ_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        ref: z.string().min(1).max(200).optional().describe("Branch or commit to read. Defaults to GITHUB_DEFAULT_BRANCH."),
        files: z.array(z.object({
          path: z.string().min(1).max(300),
          start_line: z.number().int().positive().optional(),
          end_line: z.number().int().positive().optional(),
        })).min(1).max(REPOSITORY_CHANGE_MAX_COUNT),
      }),
    },
    (args) => ({ target: `repository:files:${args.files.length}` }),
    async ({ ref, files }, token) =>
      createStructuredResult(await readRepositoryFiles({ env, token, ref, files }), "Repository files loaded."),
  );

  repoTool(
    "repo_create_implementation_branch",
    {
      title: "Create Checked Implementation Change",
      description:
        "Create one commit on a restricted temporary branch after an esa change requires implementation work. When correcting a failed check, replace the commit on the same branch by passing branch and expected_branch_head_sha. Every coding-checklist area is mandatory. Existing files require their previously read blob SHA. This never updates the default branch.",
      annotations: WRITE_TOOL_ANNOTATIONS,
      _meta: GITHUB_WRITE_META,
      inputSchema: z.object({
        expected_base_sha: shaSchema,
        branch_slug: z.string().min(1).max(60).describe("Short implementation purpose; the server creates the final managed branch name."),
        branch: z.string().min(1).max(200).optional()
          .describe("Existing managed branch to reuse after failed validation. Omit for the first implementation attempt."),
        expected_branch_head_sha: shaSchema.optional()
          .describe("Current head SHA of branch. Required together with branch when replacing a failed implementation commit."),
        commit_title: z.string().trim().min(1).max(72).regex(/^[^\r\n]+$/)
          .describe("Concise one-line English commit title. Do not include a body."),
        source_esa_posts: z.array(z.number().int().positive()).min(1).max(20),
        implementation_review: implementationReviewSchema,
        changes: z.array(repositoryChangeSchema).min(1).max(REPOSITORY_CHANGE_MAX_COUNT),
        confirm_write: z.boolean().describe("Must be true to create the implementation branch."),
      }),
    },
    (args) => ({ target: `repository:files:${args.changes.length}` }),
    async ({
      expected_base_sha: expectedBaseSha,
      branch_slug: branchSlug,
      branch,
      expected_branch_head_sha: expectedBranchHeadSha,
      commit_title: commitTitle,
      source_esa_posts: sourceEsaPosts,
      implementation_review: review,
      changes,
    }, token) => {
      const result = await createImplementationBranch({
        env,
        token,
        expectedBaseSha,
        branchSlug,
        branch,
        expectedBranchHeadSha,
        commitTitle,
        sourceEsaPosts,
        review: review as ImplementationReview,
        changes,
      });
      return createWriteResult("implementation_branch_created", result);
    },
  );

  repoTool(
    "repo_get_implementation_status",
    {
      title: "Check Implementation Validation",
      description:
        "Read GitHub check runs and commit statuses for a managed implementation branch. Can wait briefly in one server call. If checks fail, report the failure briefly and autonomously inspect, correct, and revalidate the implementation.",
      annotations: READ_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        branch: z.string().min(1).max(200),
        expected_head_sha: shaSchema,
        wait_seconds: z.number().int().min(0).max(50).default(40),
      }),
    },
    () => ({ target: "repository:checks" }),
    async ({ branch, expected_head_sha: expectedHeadSha, wait_seconds: waitSeconds }, token) =>
      createStructuredResult(await getImplementationStatus({
        env,
        token,
        branch,
        expectedHeadSha,
        waitSeconds,
      }), "Repository validation checked."),
  );

  repoTool(
    "repo_publish_implementation",
    {
      title: "Publish Validated Implementation",
      description:
        "Fast-forward the configured default branch without a pull request only when all GitHub checks pass and both expected SHAs still match, then delete the temporary branch. Never force-updates the default branch.",
      annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "検証済み実装を公開しています",
        "openai/toolInvocation/invoked": "検証済み実装を公開しました",
      },
      inputSchema: z.object({
        branch: z.string().min(1).max(200),
        expected_base_sha: shaSchema,
        expected_head_sha: shaSchema,
        confirm_write: z.boolean().describe("Must be true to fast-forward the default branch."),
      }),
    },
    () => ({ target: "repository:default-branch" }),
    async ({
      branch,
      expected_base_sha: expectedBaseSha,
      expected_head_sha: expectedHeadSha,
    }, token) => {
      const result = await publishImplementation({
        env,
        token,
        branch,
        expectedBaseSha,
        expectedHeadSha,
      });
      return createWriteResult(
        "implementation_published",
        result,
        result.temporary_branch_deleted ? OperationStatus.Completed : OperationStatus.Partial,
      );
    },
  );
}
