import {
  BatchItemStatus,
  ModelReadMode,
  ReadResultStatus,
  type ContextPrefetchMode,
  type EsaSearchOrder,
  type EsaSearchSort,
} from "../core/constants";
import { DomainStatus, inputError, normalizeToolError } from "../core/errors";
import { cleanUndefined, esaGet, fetchPost, type EsaPost } from "./esa-api";
import { findSectionInList, listSections, outlineFromSections } from "./esa-sections";

const TEXT_ENCODER = new TextEncoder();

// Independent read-only searches can run in parallel within one reviewable response.
export const SEARCH_QUERIES_MAX_COUNT = 10;
export const MODEL_READ_POSTS_MAX_COUNT = 10;
export const CONTEXT_PREFETCH_MAX_COUNT = 10;
export const POST_SECTIONS_MAX_COUNT = 20;
export const DEFAULT_MODEL_READ_MAX_CHARS = 8_000;
export const MAX_MODEL_READ_MAX_CHARS = 50_000;
export const DEFAULT_CONTEXT_ENTRY_MAX_CHARS = 12_000;
export const DEFAULT_CONTEXT_SUMMARY_MAX_CHARS = 1_200;
export const DEFAULT_CONTEXT_PREFETCH_MAX_CHARS = 12_000;

type EsaSearchResponse = {
  posts?: EsaPost[];
  total_count?: number;
  page?: number;
  per_page?: number;
  max_per_page?: number;
  prev_page?: number | null;
  next_page?: number | null;
};

function compactPost(post: EsaPost, query: string | undefined) {
  return cleanUndefined({
    number: post.number,
    title: post.name,
    full_name: post.full_name,
    category: post.category,
    tags: post.tags,
    wip: post.wip,
    url: post.url,
    updated_at: post.updated_at,
    created_at: post.created_at,
    revision_number: post.revision_number,
    comments_count: post.comments_count,
    stargazers_count: post.stargazers_count,
    watchers_count: post.watchers_count,
    updated_by: post.updated_by?.screen_name ?? post.updated_by?.name,
    snippet: makeSnippet(post.body_md, query),
  });
}

function makeSnippet(body: string | undefined, query: string | undefined, maxLength = 180) {
  if (!body) {
    return undefined;
  }

  const terms = (query ?? "")
    .split(/\s+/)
    .map((term) => term.replace(/^[-!]+/, ""))
    .filter((term) => term && !term.includes(":"))
    .sort((a, b) => b.length - a.length);
  const lowerBody = body.toLowerCase();
  const index = terms.map((term) => lowerBody.indexOf(term.toLowerCase())).find((position) => position >= 0) ?? 0;
  const start = Math.max(0, index - 60);
  const normalized = body
    .slice(start, start + maxLength)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "..." : ""}${normalized}${start + maxLength < body.length ? "..." : ""}`;
}

function markdownPost(post: EsaPost) {
  return cleanUndefined({
    number: post.number,
    title: post.name,
    full_name: post.full_name,
    url: post.url,
    revision_number: post.revision_number,
    updated_at: post.updated_at,
    body_md: post.body_md,
  });
}

function boundedMarkdownPost(post: EsaPost, maxChars: number, startChar = 0) {
  const body = post.body_md ?? "";
  const start = Math.min(Math.max(0, startChar), body.length);
  const end = Math.min(body.length, start + maxChars);
  return cleanUndefined({
    ...markdownPost(post),
    body_md: body.slice(start, end),
    total_chars: body.length,
    returned_chars: end - start,
    start_char: start,
    next_start_char: end < body.length ? end : undefined,
    truncated: end < body.length,
  });
}

function compactMarkdown(value: string) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function excerptTerms(query: string | undefined) {
  const terms = new Set<string>();
  for (const raw of (query ?? "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
    const characters = [...raw];
    if (characters.length <= 12) {
      terms.add(raw);
    }
    if (characters.length > 4) {
      for (let index = 0; index <= characters.length - 3; index += 1) {
        terms.add(characters.slice(index, index + 3).join(""));
      }
    }
  }
  return [...terms];
}

function makeRelevantExcerpt(body: string, query: string | undefined, maxChars: number) {
  const blocks = compactMarkdown(body)
    .split(/\n\s*\n/)
    .map((text, index) => ({ index, text: text.trim() }))
    .filter((block) => block.text);
  const terms = excerptTerms(query);
  const ranked = blocks.map((block) => {
    const normalized = block.text.toLowerCase().replace(/\s+/g, "");
    const score = terms.reduce((total, term) => total + (normalized.includes(term.replace(/\s+/g, "")) ? Math.min(term.length, 12) : 0), 0);
    return { ...block, score: block.text.startsWith("#") ? score + 1 : score };
  });
  const candidates = ranked.some((block) => block.score > 0)
    ? ranked.sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 16)
    : ranked;
  const selected: typeof ranked = [];
  let usedChars = 0;
  for (const block of candidates) {
    const separatorChars = selected.length ? 2 : 0;
    if (usedChars + separatorChars >= maxChars) {
      break;
    }
    const available = maxChars - usedChars - separatorChars;
    selected.push({ ...block, text: block.text.slice(0, available) });
    usedChars += separatorChars + Math.min(block.text.length, available);
    if (block.text.length > available) {
      break;
    }
  }
  selected.sort((left, right) => left.index - right.index);
  const excerpt = selected.map((block) => block.text).join("\n\n");
  return {
    excerpt_md: excerpt,
    total_chars: body.length,
    returned_chars: excerpt.length,
    selected_blocks: selected.length,
    truncated: excerpt.length < body.length,
  };
}

function outlinePost(post: EsaPost, maxHeadings?: number) {
  const body = post.body_md ?? "";
  const sections = listSections(body);
  const headingCount = sections.length;
  const outline = outlineFromSections(sections, maxHeadings);
  return cleanUndefined({
    number: post.number,
    title: post.name,
    full_name: post.full_name,
    category: post.category,
    tags: post.tags,
    wip: post.wip,
    url: post.url,
    updated_at: post.updated_at,
    revision_number: post.revision_number,
    body_chars: body.length,
    body_bytes: TEXT_ENCODER.encode(body).length,
    body_lines: body ? body.split(/\r?\n/).length : 0,
    heading_count: headingCount,
    headings_truncated: outline.length < headingCount,
    outline,
  });
}

export async function getPostModelView(options: {
  teamName: string;
  token: string;
  postNumber: number;
  mode: ModelReadMode;
  query?: string;
  maxChars?: number;
  startChar?: number;
  maxHeadings?: number;
}) {
  const post = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber });
  const maxChars = Math.min(Math.max(1, options.maxChars ?? DEFAULT_MODEL_READ_MAX_CHARS), MAX_MODEL_READ_MAX_CHARS);
  let value: unknown;
  if (options.mode === ModelReadMode.Markdown) {
    value = boundedMarkdownPost(post, maxChars, options.startChar);
  } else if (options.mode === ModelReadMode.Excerpt) {
    value = cleanUndefined({
      ...compactPost(post, undefined),
      snippet: undefined,
      query: options.query,
      ...makeRelevantExcerpt(post.body_md ?? "", options.query, maxChars),
    });
  } else if (options.mode === ModelReadMode.Outline) {
    value = outlinePost(post, options.maxHeadings);
  } else {
    value = compactPost(post, options.query);
  }
  return value;
}

export async function getPostsModelView(options: {
  teamName: string;
  token: string;
  postNumbers: number[];
  mode: ModelReadMode;
  query?: string;
  maxChars?: number;
  startChar?: number;
  maxHeadings?: number;
}) {
  const postNumbers = [...new Set(options.postNumbers)].slice(0, MODEL_READ_POSTS_MAX_COUNT);
  const bodyMode = options.mode === ModelReadMode.Markdown || options.mode === ModelReadMode.Excerpt;
  const totalMaxChars = Math.min(Math.max(1, options.maxChars ?? DEFAULT_MODEL_READ_MAX_CHARS), MAX_MODEL_READ_MAX_CHARS);
  const perPostMaxChars = bodyMode ? Math.max(1, Math.floor(totalMaxChars / Math.max(1, postNumbers.length))) : totalMaxChars;
  const posts = await Promise.all(postNumbers.map(async (postNumber) => {
    try {
      return {
        post_number: postNumber,
        status: ReadResultStatus.Success,
        result: await getPostModelView({
          ...options,
          postNumber,
          maxChars: perPostMaxChars,
        }),
      };
    } catch (error) {
      return {
        post_number: postNumber,
        status: ReadResultStatus.Failed,
        error: normalizeToolError(error),
      };
    }
  }));
  return cleanUndefined({
    mode: options.mode,
    total: posts.length,
    succeeded: posts.filter((post) => post.status === ReadResultStatus.Success).length,
    failed: posts.filter((post) => post.status === ReadResultStatus.Failed).length,
    total_max_chars: bodyMode ? totalMaxChars : undefined,
    per_post_max_chars: bodyMode ? perPostMaxChars : undefined,
    posts,
  });
}

export type ContextPrefetchInput = {
  postNumber: number;
  mode: ContextPrefetchMode;
  query?: string;
  maxHeadings?: number;
};

async function prefetchContextPost(options: {
  teamName: string;
  token: string;
  input: ContextPrefetchInput;
  maxChars: number;
}) {
  try {
    const result = await getPostModelView({
      teamName: options.teamName,
      token: options.token,
      postNumber: options.input.postNumber,
      mode: options.input.mode,
      query: options.input.query,
      maxChars: options.maxChars,
      maxHeadings: options.input.maxHeadings,
    });

    return {
      post_number: options.input.postNumber,
      mode: options.input.mode,
      status: ReadResultStatus.Success,
      result,
    };
  } catch (error) {
    const normalized = normalizeToolError(error);
    return cleanUndefined({
      post_number: options.input.postNumber,
      mode: options.input.mode,
      status: ReadResultStatus.Failed,
      error: {
        domain_status: normalized.domain_status,
        message_ja: normalized.message_ja,
        hint_ja: normalized.hint_ja,
        http_status: normalized.http_status,
      },
    });
  }
}

export async function loadContextEntry(options: {
  teamName: string;
  token: string;
  postNumber: number;
  summaryPostNumber?: number;
  includeSummary?: boolean;
  entryMaxChars?: number;
  summaryMaxChars?: number;
  prefetchPosts?: ContextPrefetchInput[];
  prefetchMaxChars?: number;
}) {
  const reservedPostNumbers = new Set([
    options.postNumber,
    ...(options.includeSummary && options.summaryPostNumber ? [options.summaryPostNumber] : []),
  ]);
  const seenPostNumbers = new Set<number>();
  const prefetchPosts = (options.prefetchPosts ?? [])
    .filter((input) => {
      if (reservedPostNumbers.has(input.postNumber) || seenPostNumbers.has(input.postNumber)) {
        return false;
      }
      seenPostNumbers.add(input.postNumber);
      return true;
    })
    .slice(0, CONTEXT_PREFETCH_MAX_COUNT);
  const bodyPrefetchCount = prefetchPosts.filter((input) => input.mode !== ModelReadMode.Outline).length;
  const prefetchMaxChars = Math.min(
    Math.max(1, options.prefetchMaxChars ?? DEFAULT_CONTEXT_PREFETCH_MAX_CHARS),
    MAX_MODEL_READ_MAX_CHARS,
  );
  const perBodyPrefetchMaxChars = Math.max(1, Math.floor(prefetchMaxChars / Math.max(1, bodyPrefetchCount)));

  const [post, summary, prefetchedPosts] = await Promise.all([
    fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber }),
    options.includeSummary && options.summaryPostNumber
      ? fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.summaryPostNumber })
      : undefined,
    Promise.all(
      prefetchPosts.map((input) => prefetchContextPost({
        teamName: options.teamName,
        token: options.token,
        input,
        maxChars: input.mode === ModelReadMode.Outline ? DEFAULT_MODEL_READ_MAX_CHARS : perBodyPrefetchMaxChars,
      })),
    ),
  ]);

  return cleanUndefined({
    summary_status: summary
      ? "loaded"
      : options.summaryPostNumber
        ? "available_on_demand"
        : "not_configured",
    summary_post_number: options.summaryPostNumber,
    entry: boundedMarkdownPost(
      post,
      Math.min(Math.max(1, options.entryMaxChars ?? DEFAULT_CONTEXT_ENTRY_MAX_CHARS), MAX_MODEL_READ_MAX_CHARS),
    ),
    current_summary: summary
      ? boundedMarkdownPost(
          summary,
          Math.min(Math.max(1, options.summaryMaxChars ?? DEFAULT_CONTEXT_SUMMARY_MAX_CHARS), MAX_MODEL_READ_MAX_CHARS),
        )
      : undefined,
    prefetch_max_chars: bodyPrefetchCount ? prefetchMaxChars : undefined,
    prefetched_posts: prefetchedPosts.length ? prefetchedPosts : undefined,
  });
}

export async function searchPostsLightweight(options: {
  teamName: string;
  token: string;
  q?: string;
  page?: number;
  perPage?: number;
  sort?: EsaSearchSort;
  order?: EsaSearchOrder;
}) {
  const result = await esaGet<EsaSearchResponse>({
    teamName: options.teamName,
    path: "/posts",
    token: options.token,
    searchParams: {
      q: options.q,
      page: options.page,
      per_page: options.perPage,
      sort: options.sort,
      order: options.order,
    },
  });

  return cleanUndefined({
    total_count: result.total_count,
    page: result.page,
    per_page: result.per_page,
    prev_page: result.prev_page,
    next_page: result.next_page,
    posts: (result.posts ?? []).map((post) => compactPost(post, options.q)),
  });
}

export type SearchQueryInput = {
  q?: string;
  page?: number;
  perPage?: number;
  sort?: EsaSearchSort;
  order?: EsaSearchOrder;
};

export async function searchPostsMulti(options: {
  teamName: string;
  token: string;
  queries: SearchQueryInput[];
  includeBody?: boolean;
}) {
  if (options.queries.length === 0) {
    throw inputError("Pass at least one query.", "Pass one or more queries.");
  }
  if (options.queries.length > SEARCH_QUERIES_MAX_COUNT) {
    throw inputError(
      `Pass at most ${SEARCH_QUERIES_MAX_COUNT} queries per call. Got ${options.queries.length}.`,
      `Split queries into batches of ${SEARCH_QUERIES_MAX_COUNT} or fewer.`,
      DomainStatus.MultiSearchLimitExceeded,
    );
  }

  // A failed query stays local to its result instead of rejecting the batch.
  const results = await Promise.all(
    options.queries.map(async (query) => {
      try {
        const result = options.includeBody
          ? cleanUndefined(
              await esaGet<EsaSearchResponse>({
                teamName: options.teamName,
                path: "/posts",
                token: options.token,
                searchParams: { q: query.q, page: query.page, per_page: query.perPage, sort: query.sort, order: query.order },
              }),
            )
          : await searchPostsLightweight({ teamName: options.teamName, token: options.token, ...query });
        return {
          query: cleanUndefined({ q: query.q, page: query.page, per_page: query.perPage, sort: query.sort, order: query.order }),
          status: BatchItemStatus.Ok,
          ...result,
        };
      } catch (error) {
        return {
          query: cleanUndefined({ q: query.q, page: query.page, per_page: query.perPage, sort: query.sort, order: query.order }),
          status: BatchItemStatus.Error,
          error: normalizeToolError(error),
        };
      }
    }),
  );

  const succeeded = results.filter((result) => result.status === BatchItemStatus.Ok).length;
  return { total: results.length, succeeded, failed: results.length - succeeded, queries: results };
}

export async function readPostSections(options: {
  teamName: string;
  token: string;
  postNumber: number;
  sections: {
    heading: string;
    occurrence?: number;
    headingLevel?: number;
    includeHeading?: boolean;
  }[];
  maxChars?: number;
}) {
  const post = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber });
  const body = post.body_md ?? "";
  const maxChars = options.maxChars === undefined
    ? undefined
    : Math.min(Math.max(1, options.maxChars), MAX_MODEL_READ_MAX_CHARS);
  const availableSections = listSections(body);
  let remainingChars = maxChars;
  const sections = options.sections.map((input) => {
    const section = findSectionInList(availableSections, input.heading, input.occurrence, input.headingLevel);
    const fullBodyMd = body.slice(input.includeHeading === false ? section.contentStart : section.start, section.end).trim();
    const bodyMd = remainingChars === undefined ? fullBodyMd : fullBodyMd.slice(0, remainingChars);
    if (remainingChars !== undefined) {
      remainingChars = Math.max(0, remainingChars - bodyMd.length);
    }
    return {
      heading: section.heading,
      heading_level: section.level,
      occurrence: section.occurrence,
      body_md: bodyMd,
      total_chars: maxChars === undefined ? undefined : fullBodyMd.length,
      returned_chars: maxChars === undefined ? undefined : bodyMd.length,
      truncated: maxChars === undefined ? undefined : bodyMd.length < fullBodyMd.length,
    };
  });

  return cleanUndefined({
    number: post.number,
    title: post.name,
    url: post.url,
    revision_number: post.revision_number,
    max_chars: maxChars,
    sections,
  });
}

export function getPostCollection(options: {
  teamName: string;
  token: string;
  postNumber: number;
  collection: "comments" | "backlinks";
  page?: number;
  perPage?: number;
}) {
  return esaGet({
    teamName: options.teamName,
    path: `/posts/${options.postNumber}/${options.collection}`,
    token: options.token,
    searchParams: { page: options.page, per_page: options.perPage },
  });
}
