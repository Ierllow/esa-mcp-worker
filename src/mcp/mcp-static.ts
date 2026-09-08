import { z } from "zod";
import {
  EsaPostInclude,
  EsaSearchOrder,
  EsaSearchSort,
  ModelReadMode,
} from "../core/constants";
import {
  CONTEXT_PREFETCH_MAX_COUNT,
  DEFAULT_CONTEXT_ENTRY_MAX_CHARS,
  DEFAULT_CONTEXT_PREFETCH_MAX_CHARS,
  DEFAULT_CONTEXT_SUMMARY_MAX_CHARS,
  DEFAULT_MODEL_READ_MAX_CHARS,
  MAX_MODEL_READ_MAX_CHARS,
  MODEL_READ_POSTS_MAX_COUNT,
  POST_SECTIONS_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
} from "../esa/esa";

export const SERVER_INFO = {
  name: "esa Remote MCP",
  version: "0.1.0",
};

export const FAST_INSTRUCTIONS = [
  "Call esa_load_context_entry once before the first answer and prefetch explicit article numbers in that call.",
  "Omit team_name and configured post numbers unless overriding deployment defaults.",
  "Prefer outline for structure, excerpt for focused questions, and bounded markdown only for full comparison. Do not reread returned posts.",
  "Use batch inputs for independent reads. Read more only when the returned content is insufficient.",
  "When asked for more, deepen the strongest existing point instead of padding the answer or adding topics.",
  "After tool use, end with `MCP server: X秒` using elapsed_seconds.",
].join("\n");

export const FULL_INSTRUCTIONS = [
  "Call esa_load_context_entry once before the first answer. Prefetch article numbers explicitly present in the request and do not announce the load.",
  "Omit team_name and configured post numbers unless overriding deployment defaults.",
  "Load the summary only for broad current context. Prefer outline, then excerpt, then bounded markdown.",
  "Batch independent reads and keep writes ordered. Do not reread completed results.",
  "When asked for more, deepen the strongest existing point instead of padding the answer or adding topics.",
  "When an authorized esa correction changes runtime behavior, tool contracts, configuration, security, errors, performance, tests, or documentation, assess every implementation-review area and update the configured repository in the same task.",
  "For each repository update, use one managed branch with one concise English title-only commit. Wait for GitHub checks, publish only after validation is ready, then delete the temporary branch. Do not open a pull request, force-update the default branch, or claim completion before publication.",
  "If implementation checks fail, briefly report the failed check, inspect the failure and branch files, then replace the commit on the same branch and revalidate it. Stop only for a credential, permission, service, or ambiguous-requirement blocker that code cannot resolve.",
  "A completed write with needs_follow_up=false is done; inspect only failures in partial results.",
  "After tool use, end with `MCP server: X秒` using elapsed_seconds; sum sequential calls and use the maximum for parallel calls.",
].join("\n");

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS = {
  ...WRITE_TOOL_ANNOTATIONS,
  destructiveHint: true,
};

export const WRITE_TOOL_META = {
  "openai/toolInvocation/invoking": "esaを更新しています",
  "openai/toolInvocation/invoked": "esaの更新が完了しました",
};

export const OPTIONAL_TEAM_NAME_SCHEMA = z
  .string()
  .min(1)
  .optional()
  .describe("esa team name. Optional when ESA_DEFAULT_TEAM is configured.");

export const POST_NUMBER_SCHEMA = z.number().int().positive().describe("esa post number.");

export const PAGE_SCHEMA = z.number().int().positive().max(1000).optional().describe("Page number.");

export const PER_PAGE_SCHEMA = z.number().int().positive().max(100).optional().describe("Results per page.");

export const HEADING_SCHEMA = z.string().min(1).describe("Heading text without leading # characters.");

export const OCCURRENCE_SCHEMA = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Use when the same heading appears multiple times.");

export const HEADING_LEVEL_SCHEMA = z.number().int().min(1).max(6).optional().describe("Optional markdown heading level.");

export const MAX_HEADINGS_SCHEMA = z.number().int().positive().max(300).optional().describe("Maximum headings to return.");

export const EXPECTED_REVISION_NUMBER_SCHEMA = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Optional guard against stale reads.");

export const REVISION_MESSAGE_SCHEMA = z.string().optional().describe("Optional revision message.");

export const CONFIRM_WRITE_SCHEMA = z.boolean().describe("Must be true to write to esa.");

export const POST_TAGS_SCHEMA = z.array(z.string().min(1)).optional().describe("Optional tags.");

export const POST_CATEGORY_SCHEMA = z.string().min(1).optional().describe("Optional category path.");

export const SEARCH_QUERY_SCHEMA = z.object({
  q: z.string().optional().describe("esa search query, such as in:help keyword"),
  page: PAGE_SCHEMA,
  per_page: PER_PAGE_SCHEMA,
  sort: z.enum(EsaSearchSort).optional().describe("Sort key."),
  order: z.enum(EsaSearchOrder).optional().describe("Sort order."),
});

export const LOAD_CONTEXT_ENTRY_SCHEMA = z.object({
  team_name: OPTIONAL_TEAM_NAME_SCHEMA,
  entry_post_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Context entry post number. Optional when ESA_CONTEXT_ENTRY_POST_NUMBER is configured."),
  summary_post_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Current summary post number. Optional when ESA_CONTEXT_SUMMARY_POST_NUMBER is configured."),
  include_summary: z
    .boolean()
    .default(false)
    .describe("Load the configured current summary too. Use only for broad or current-context questions."),
  entry_max_chars: z
    .number()
    .int()
    .positive()
    .max(MAX_MODEL_READ_MAX_CHARS)
    .optional()
    .describe(`Entry body limit. Default ${DEFAULT_CONTEXT_ENTRY_MAX_CHARS}.`),
  summary_max_chars: z
    .number()
    .int()
    .positive()
    .max(MAX_MODEL_READ_MAX_CHARS)
    .optional()
    .describe(`Summary body limit. Default ${DEFAULT_CONTEXT_SUMMARY_MAX_CHARS}.`),
  prefetch_max_chars: z
    .number()
    .int()
    .positive()
    .max(MAX_MODEL_READ_MAX_CHARS)
    .optional()
    .describe(`Combined body limit for prefetch. Default ${DEFAULT_CONTEXT_PREFETCH_MAX_CHARS}.`),
  prefetch_posts: z
    .array(z.object({
      post_number: z.number().int().positive().describe("Article number explicitly present in the user request."),
      mode: z
        .enum([ModelReadMode.Markdown, ModelReadMode.Excerpt, ModelReadMode.Outline])
        .describe("Use excerpt for focused analysis, markdown for full comparison, or outline for structure."),
      query: z.string().max(500).optional().describe("Question or keywords for excerpt mode."),
      max_headings: MAX_HEADINGS_SCHEMA.describe("Maximum headings for outline mode."),
    }))
    .max(CONTEXT_PREFETCH_MAX_COUNT)
    .optional()
    .describe("Explicitly requested articles to fetch in parallel with the context entry. Do not include inferred articles."),
});

export const GET_POST_SCHEMA = z.object({
  team_name: OPTIONAL_TEAM_NAME_SCHEMA,
  post_number: z.number().int().positive().optional().describe("One post number."),
  post_numbers: z
    .array(z.number().int().positive())
    .min(1)
    .max(MODEL_READ_POSTS_MAX_COUNT)
    .optional()
    .describe(`One to ${MODEL_READ_POSTS_MAX_COUNT} post numbers.`),
  mode: z.enum(ModelReadMode).optional().describe("Default metadata. Prefer excerpt over markdown."),
  query: z.string().max(500).optional().describe("Question or keywords for metadata/excerpt selection."),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(MAX_MODEL_READ_MAX_CHARS)
    .optional()
    .describe(`Combined excerpt/Markdown limit. Default ${DEFAULT_MODEL_READ_MAX_CHARS}.`),
  start_char: z.number().int().nonnegative().optional().describe("Continuation offset for bounded Markdown."),
  max_headings: MAX_HEADINGS_SCHEMA.describe("Outline limit."),
  include: z.enum(EsaPostInclude).optional().describe("Single-post esa include. Article bodies are removed."),
  include_body: z.boolean().optional().describe("Legacy alias for mode=markdown."),
  include_outline: z.boolean().optional().describe("Legacy alias for mode=outline."),
});

export const SEARCH_POSTS_SCHEMA = z.object({
  team_name: OPTIONAL_TEAM_NAME_SCHEMA,
  q: z.string().optional().describe("esa search query, such as in:help keyword"),
  page: PAGE_SCHEMA,
  per_page: PER_PAGE_SCHEMA,
  sort: z.enum(EsaSearchSort).optional().describe("Sort key."),
  order: z.enum(EsaSearchOrder).optional().describe("Sort order."),
  include_body: z.boolean().optional().describe("Set true only when full post bodies are needed."),
  queries: z
    .array(SEARCH_QUERY_SCHEMA)
    .optional()
    .describe(`Run multiple searches in one call, ${SEARCH_QUERIES_MAX_COUNT} at most. Mutually exclusive with q/page/per_page/sort/order.`),
});

export const READ_SECTIONS_SCHEMA = z.object({
  team_name: OPTIONAL_TEAM_NAME_SCHEMA,
  post_number: POST_NUMBER_SCHEMA,
  sections: z
    .array(
      z.object({
        heading: HEADING_SCHEMA,
        occurrence: OCCURRENCE_SCHEMA,
        heading_level: HEADING_LEVEL_SCHEMA,
        include_heading: z.boolean().optional().describe("Set false to return section contents without the heading line."),
      }),
    )
    .min(1)
    .max(POST_SECTIONS_MAX_COUNT)
    .describe("Sections to fetch."),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(MAX_MODEL_READ_MAX_CHARS)
    .optional()
    .describe(`Combined section limit. /mcp-fast defaults to ${DEFAULT_MODEL_READ_MAX_CHARS}.`),
});

export const CHECK_CONTEXT_DRIFT_SCHEMA = z.object({
  team_name: OPTIONAL_TEAM_NAME_SCHEMA,
  include_unchanged: z.boolean().optional().describe("Set true to include unchanged observed posts."),
});

export const ACTIVE_PAGE_REGISTRY_LINT_SCHEMA = z.object({
  team_name: OPTIONAL_TEAM_NAME_SCHEMA,
  registry_post_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Registry post number. Optional when ESA_ACTIVE_PAGE_REGISTRY_POST_NUMBER is configured."),
});
