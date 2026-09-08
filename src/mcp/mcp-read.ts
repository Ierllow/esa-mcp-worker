import { z } from "zod";
import { McpProfile, ModelReadMode } from "../core/constants";
import { inputError } from "../core/errors";
import { createContextResult, createTextResult } from "../core/utils";
import {
  DEFAULT_MODEL_READ_MAX_CHARS,
  SEARCH_QUERIES_MAX_COUNT,
  checkContextDrift,
  esaGet,
  firstPostNumber,
  getPostCollection,
  getPostsModelView,
  loadContextEntry,
  readPostSections,
  resolveContextEntryPostNumber,
  resolveContextSummaryPostNumber,
  resolveTeamName,
  runEsaCommand,
  searchPostsLightweight,
  searchPostsMulti,
} from "../esa/esa";
import { lintActivePageRegistry, resolveActivePageRegistryPostNumber } from "../state/active-page-registry";
import {
  ACTIVE_PAGE_REGISTRY_LINT_SCHEMA,
  CHECK_CONTEXT_DRIFT_SCHEMA,
  GET_POST_SCHEMA,
  LOAD_CONTEXT_ENTRY_SCHEMA,
  OPTIONAL_TEAM_NAME_SCHEMA,
  PAGE_SCHEMA,
  PER_PAGE_SCHEMA,
  POST_NUMBER_SCHEMA,
  READ_SECTIONS_SCHEMA,
  READ_TOOL_ANNOTATIONS,
  SEARCH_POSTS_SCHEMA,
} from "./mcp-static";
import type { McpRegistration } from "./mcp-registration";

export function registerContextEntryTool({ registerTool, track, env, token }: McpRegistration) {
  const readToolAnnotations = READ_TOOL_ANNOTATIONS;
  registerTool(
    "esa_load_context_entry",
    {
      title: "Load esa Context Entry",
      annotations: readToolAnnotations,
      description:
        "Call automatically exactly once before the first answer in each conversation where this MCP server is enabled. Loads the thin configured entry by default and can prefetch explicitly requested articles in the same parallel server operation. Set include_summary=true only for broad or current-context questions. Do not summarize the load or request confirmation.",
      _meta: {
        "openai/toolInvocation/invoking": "会話コンテキストを読み込んでいます",
        "openai/toolInvocation/invoked": "会話コンテキストを読み込みました",
      },
      inputSchema: LOAD_CONTEXT_ENTRY_SCHEMA,
    },
    async ({
      team_name: inputTeamName,
      entry_post_number: entryPostNumber,
      summary_post_number: summaryPostNumberInput,
      include_summary: includeSummary,
      entry_max_chars: entryMaxChars,
      summary_max_chars: summaryMaxChars,
      prefetch_max_chars: prefetchMaxChars,
      prefetch_posts: prefetchPosts,
    }) => {
      const postNumber = resolveContextEntryPostNumber(entryPostNumber, env);
      const summaryPostNumber = resolveContextSummaryPostNumber(summaryPostNumberInput, env);
      const targetPostNumbers = [
        postNumber,
        ...(includeSummary && summaryPostNumber ? [summaryPostNumber] : []),
        ...(prefetchPosts ?? []).map((input) => input.post_number),
      ];
      return track("esa_load_context_entry", { target: `posts:${targetPostNumbers.join(",")}` }, async () => {
        const teamName = resolveTeamName(inputTeamName, env);
        const result = await loadContextEntry({
          teamName,
          token,
          postNumber,
          summaryPostNumber,
          includeSummary,
          entryMaxChars,
          summaryMaxChars,
          prefetchMaxChars,
          prefetchPosts: prefetchPosts?.map((input) => ({
            postNumber: input.post_number,
            mode: input.mode,
            query: input.query,
            maxHeadings: input.max_headings,
          })),
        });
        return createContextResult(result);
      });
    },
  );
}

export function registerCommandTool({ esaTool, token }: McpRegistration) {
  const readToolAnnotations = READ_TOOL_ANNOTATIONS;
  esaTool(
    "esa_command",
    {
      title: "Run esa Command",
      annotations: readToolAnnotations,
      description:
        "Run short esa commands. Examples: `#123`, `post 123`, `comments 123`, `backlinks 123`, `search keyword`, `outline 123`, `compact 123`, `tags`, `categories`.",
      inputSchema: z.object({
        command: z.string().min(1).describe("Short esa command, for example `#123` or `search onboarding`."),
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
      }),
    },
    ({ command }) => {
      const postNumber = firstPostNumber(command);
      return { target: postNumber ? `post:${postNumber}` : "command" };
    },
    async ({ command }, teamName) => createTextResult(await runEsaCommand(command, teamName, token)),
  );
}

export function registerCommonReadTools({ esaTool, env, token }: McpRegistration, profile: McpProfile) {
  const readToolAnnotations = READ_TOOL_ANNOTATIONS;
  const requireSingleQueryFieldsUnset = (fields: Record<string, unknown>) => {
    if (Object.values(fields).some((value) => value !== undefined)) {
      throw inputError(
        "Pass either queries or the single-query fields (q/page/per_page/sort/order), not both.",
        "Use queries for multiple searches in one call, or q for a single search.",
      );
    }
  };
  esaTool(
    "esa_get_post",
    {
      title: "Read esa Posts",
      annotations: readToolAnnotations,
      description: "Read one or more posts in parallel as metadata, outline, focused excerpt, or bounded Markdown.",
      inputSchema: GET_POST_SCHEMA,
    },
    ({ post_number: postNumber, post_numbers: postNumbersInput }) => {
      if ((postNumber === undefined) === (postNumbersInput === undefined)) {
        throw inputError("Pass either post_number or post_numbers.", "Choose one post selector, not both.");
      }
      return { target: `posts:${[...new Set(postNumbersInput ?? [postNumber!])].join(",")}` };
    },
    async ({
      post_number: postNumber,
      post_numbers: postNumbersInput,
      mode: modeInput,
      query,
      max_chars: maxChars,
      start_char: startChar,
      max_headings: maxHeadings,
      include,
      include_body: includeBody,
      include_outline: includeOutline,
    }, teamName) => {
      const postNumbers = postNumbersInput ?? [postNumber!];
      if (include) {
        if (postNumbers.length !== 1) {
          throw inputError("include supports one post only.", "Use post_number with include.");
        }
        const rawPost = await esaGet<Record<string, unknown>>({
          teamName,
          path: `/posts/${postNumbers[0]}`,
          token,
          searchParams: { include },
        });
        const markdownOnlyPost = { ...rawPost };
        delete markdownOnlyPost.body_html;
        delete markdownOnlyPost.body_md;
        return createTextResult(markdownOnlyPost);
      }
      const mode = modeInput ?? (
        includeBody
          ? ModelReadMode.Markdown
          : includeOutline
            ? ModelReadMode.Outline
            : ModelReadMode.Metadata
      );
      const result = await getPostsModelView({
        teamName,
        token,
        postNumbers,
        mode,
        query,
        maxChars,
        startChar,
        maxHeadings,
      });
      return createTextResult(result);
    },
  );

  esaTool(
    "esa_search_posts",
    {
      title: "Search esa Posts",
      annotations: readToolAnnotations,
      description: `Search metadata and snippets. Use queries for up to ${SEARCH_QUERIES_MAX_COUNT} parallel searches.`,
      inputSchema: SEARCH_POSTS_SCHEMA,
    },
    (args) => ({ target: args.queries ? `search:${args.queries.length}` : args.q ? "search" : "posts" }),
    async ({ q, page, per_page: perPage, sort, order, include_body: includeBody, queries }, teamName) => {
      if (profile === McpProfile.Fast && includeBody) {
        throw inputError("Full search bodies are disabled on /mcp-fast.", "Search first, then read selected posts as excerpt or bounded markdown.");
      }

      if (queries) {
        requireSingleQueryFieldsUnset({ q, page, perPage, sort, order });
        const result = await searchPostsMulti({
          teamName,
          token,
          includeBody,
          queries: queries.map((query) => ({
            q: query.q,
            page: query.page,
            perPage: profile === McpProfile.Fast ? Math.min(query.per_page ?? 20, 20) : query.per_page,
            sort: query.sort,
            order: query.order,
          })),
        });
        return createTextResult(result);
      }

      const posts = includeBody
        ? await esaGet({
            teamName,
            path: "/posts",
            token,
            searchParams: { q, page, per_page: perPage, sort, order },
          })
        : await searchPostsLightweight({
            teamName,
            token,
            q,
            page,
            perPage: profile === McpProfile.Fast ? Math.min(perPage ?? 20, 20) : perPage,
            sort,
            order,
          });
      return createTextResult(posts);
    },
  );

  esaTool(
    "esa_read_sections",
    {
      title: "Read esa Sections",
      annotations: readToolAnnotations,
      description: "Fetch multiple markdown heading sections from one esa post in one tool call.",
      inputSchema: READ_SECTIONS_SCHEMA,
    },
    (args) => ({ target: `post:${args.post_number}` }),
    async ({ post_number: postNumber, sections, max_chars: maxChars }, teamName) => {
      const result = await readPostSections({
        teamName,
        token,
        postNumber,
        sections: sections.map((section) => ({
          heading: section.heading,
          occurrence: section.occurrence,
          headingLevel: section.heading_level,
          includeHeading: section.include_heading,
        })),
        maxChars: maxChars ?? (profile === McpProfile.Fast ? DEFAULT_MODEL_READ_MAX_CHARS : undefined),
      });
      return createTextResult(result);
    },
  );

  esaTool(
    "esa_check_context_drift",
    {
      title: "Check esa Context Drift",
      annotations: readToolAnnotations,
      description:
        "Compare the Cloudflare KV context observer with current esa revisions and context_version values. Returns small metadata only, not article bodies.",
      inputSchema: CHECK_CONTEXT_DRIFT_SCHEMA,
    },
    () => ({ target: "context:observer" }),
    async ({ include_unchanged: includeUnchanged }, teamName) => {
      const drift = await checkContextDrift({
        env,
        teamName,
        token,
        includeUnchanged,
      });
      return createTextResult(drift);
    },
  );
}

export function registerFullReadTools({ esaTool, env, token }: McpRegistration) {
  const readToolAnnotations = READ_TOOL_ANNOTATIONS;
  esaTool(
    "esa_lint_active_page_registry",
    {
      title: "Lint esa Active Page Registry",
      annotations: readToolAnnotations,
      description:
        "Parse the configured control-plane YAML registry and check live posts, archived targets, successors, entry reachability, and Cloudflare KV observer coverage. Use only during structure audits or registry changes.",
      inputSchema: ACTIVE_PAGE_REGISTRY_LINT_SCHEMA,
    },
    () => ({ target: "context:registry" }),
    async ({ registry_post_number: registryPostNumberInput }, teamName) => {
      const registryPostNumber = resolveActivePageRegistryPostNumber(registryPostNumberInput, env);
      const result = await lintActivePageRegistry({
        env,
        teamName,
        token,
        registryPostNumber,
      });
      return createTextResult(result);
    },
  );

  const postCollectionSchema = z.object({
    team_name: OPTIONAL_TEAM_NAME_SCHEMA,
    post_number: POST_NUMBER_SCHEMA,
    page: PAGE_SCHEMA,
    per_page: PER_PAGE_SCHEMA,
  });
  for (const tool of [
    { name: "esa_get_comments", title: "Get esa Comments", description: "Fetch comments for a single esa post.", collection: "comments" },
    { name: "esa_get_backlinks", title: "Get esa Backlinks", description: "Fetch backlinks for a single esa post.", collection: "backlinks" },
  ] as const) {
    esaTool(
      tool.name,
      {
        title: tool.title,
        annotations: readToolAnnotations,
        description: tool.description,
        inputSchema: postCollectionSchema,
      },
      (args) => ({ target: `post:${args.post_number}` }),
      async ({ post_number: postNumber, page, per_page: perPage }, teamName) => {
        const result = await getPostCollection({ teamName, token, postNumber, collection: tool.collection, page, perPage });
        return createTextResult(result);
      },
    );
  }
}
