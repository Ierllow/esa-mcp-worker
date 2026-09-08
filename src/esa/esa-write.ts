import { BatchItemStatus, EsaRequestAccess, HttpMethod, PostPatchType } from "../core/constants";
import { DomainStatus, ToolError, esaRateLimitError, inputError, normalizeToolError } from "../core/errors";
import type { EsaRateLimitInfo } from "../core/types";
import { invalidateTeamPostCache } from "../state/post-cache";
import { cleanUndefined, compactUpdatedPost, esaRequest, fetchPost, type EsaPost } from "./esa-api";
import { findSection, findSectionInList, listSections } from "./esa-sections";

const TEXT_ENCODER = new TextEncoder();

// Keep bulk calls reviewable; large bodies are limited by payload size before item count.
export const BULK_CREATE_POSTS_MAX_COUNT = 20;
export const BULK_CREATE_TOTAL_PAYLOAD_BYTES_BUDGET = 200 * 1024; // 200 KiB combined per call
export const BULK_UPDATE_POSTS_MAX_COUNT = 20;
export const BULK_UPDATE_TOTAL_PAYLOAD_BYTES_BUDGET = 200 * 1024; // 200 KiB combined per call

function formatSectionBody(body: string) {
  const trimmed = body.trim();
  return trimmed ? `${trimmed}\n\n` : "";
}

function replaceOccurrence(body: string, oldText: string, newText: string, occurrence?: number) {
  if (!oldText) {
    throw inputError("old_text is required for replace_text patches.", "Pass old_text and new_text for replace_text patches.", DomainStatus.PatchTextRequired);
  }

  if (!occurrence) {
    const first = body.indexOf(oldText);
    if (first < 0) {
      throw inputError("old_text was not found.", "Check that old_text matches the current post body.", DomainStatus.PatchTargetNotFound);
    }
    if (body.indexOf(oldText, first + oldText.length) >= 0) {
      throw inputError("old_text appears multiple times. Pass occurrence to choose one.", "Pass occurrence to choose which matching text to replace.", DomainStatus.PatchTargetAmbiguous);
    }
    return `${body.slice(0, first)}${newText}${body.slice(first + oldText.length)}`;
  }

  let index = -1;
  let from = 0;
  for (let count = 0; count < occurrence; count += 1) {
    index = body.indexOf(oldText, from);
    if (index < 0) {
      throw inputError(`old_text occurrence ${occurrence} was not found.`, "Check occurrence against the current post body.", DomainStatus.PatchTargetNotFound);
    }
    from = index + oldText.length;
  }

  return `${body.slice(0, index)}${newText}${body.slice(index + oldText.length)}`;
}

async function updatePostBody(options: {
  teamName: string;
  token: string;
  postNumber: number;
  post: EsaPost;
  bodyMd: string;
  message?: string;
  expectedRevisionNumber?: number;
}) {
  const originalBody = options.post.body_md ?? "";
  if (options.expectedRevisionNumber && options.post.revision_number !== options.expectedRevisionNumber) {
    throw inputError(
      `Post revision changed. Expected ${options.expectedRevisionNumber}, got ${options.post.revision_number ?? "unknown"}. Read the post again before patching.`,
      "Read the current compact post or section, then retry with the latest revision.",
      DomainStatus.RevisionConflict,
    );
  }
  if (originalBody === options.bodyMd) {
    throw inputError("Patch did not change the post body.", "Check old_text, new_text, or section_body_md.", DomainStatus.PatchNoChange);
  }

  const updated = await esaRequest<EsaPost>({
    teamName: options.teamName,
    path: `/posts/${options.postNumber}`,
    token: options.token,
    method: HttpMethod.Patch,
    access: EsaRequestAccess.Write,
    body: {
      post: cleanUndefined({
        body_md: options.bodyMd,
        message: options.message,
        original_revision: {
          body_md: originalBody,
          number: options.post.revision_number,
          user: options.post.updated_by?.screen_name,
        },
      }),
    },
  });

  return compactUpdatedPost(updated);
}

export async function patchPost(options: {
  teamName: string;
  token: string;
  postNumber: number;
  patchType: PostPatchType;
  heading?: string;
  sectionBodyMd?: string;
  oldText?: string;
  newText?: string;
  occurrence?: number;
  headingLevel?: number;
  expectedRevisionNumber?: number;
  message?: string;
}) {
  const post = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber });
  const body = post.body_md ?? "";
  let nextBody: string;

  if (options.patchType === PostPatchType.ReplaceSection) {
    if (!options.heading) {
      throw inputError("heading is required for replace_section patches.", "Pass heading for replace_section patches.", DomainStatus.HeadingRequired);
    }
    if (options.sectionBodyMd === undefined) {
      throw inputError("section_body_md is required for replace_section patches.", "Pass section_body_md for replace_section patches.", DomainStatus.SectionBodyRequired);
    }

    const section = findSection(body, options.heading, options.occurrence, options.headingLevel);
    nextBody = `${body.slice(0, section.contentStart)}${formatSectionBody(options.sectionBodyMd)}${body.slice(section.end)}`;
  } else {
    if (options.oldText === undefined || options.newText === undefined) {
      throw inputError("old_text and new_text are required for replace_text patches.", "Pass both old_text and new_text for replace_text patches.", DomainStatus.PatchTextRequired);
    }
    nextBody = replaceOccurrence(body, options.oldText, options.newText, options.occurrence);
  }

  return updatePostBody({
    teamName: options.teamName,
    token: options.token,
    postNumber: options.postNumber,
    post,
    bodyMd: nextBody,
    message: options.message,
    expectedRevisionNumber: options.expectedRevisionNumber,
  });
}

export async function patchPostSections(options: {
  teamName: string;
  token: string;
  postNumber: number;
  sections: {
    heading: string;
    sectionBodyMd: string;
    occurrence?: number;
    headingLevel?: number;
  }[];
  expectedRevisionNumber?: number;
  message?: string;
}) {
  const post = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber });
  const body = post.body_md ?? "";
  const availableSections = listSections(body);
  const replacements = options.sections.map((input) => ({
    section: findSectionInList(availableSections, input.heading, input.occurrence, input.headingLevel),
    sectionBodyMd: input.sectionBodyMd,
  }));
  const orderedReplacements = [...replacements].sort((a, b) => a.section.contentStart - b.section.contentStart);
  for (let index = 1; index < orderedReplacements.length; index += 1) {
    if (orderedReplacements[index - 1].section.end > orderedReplacements[index].section.contentStart) {
      throw inputError("Section patches must not overlap.", "Do not patch the same section range more than once.", DomainStatus.SectionPatchOverlap);
    }
  }
  const sortedReplacements = replacements.sort((a, b) => b.section.contentStart - a.section.contentStart);
  let nextBody = body;

  for (const replacement of sortedReplacements) {
    nextBody = `${nextBody.slice(0, replacement.section.contentStart)}${formatSectionBody(replacement.sectionBodyMd)}${nextBody.slice(replacement.section.end)}`;
  }

  return updatePostBody({
    teamName: options.teamName,
    token: options.token,
    postNumber: options.postNumber,
    post,
    bodyMd: nextBody,
    message: options.message,
    expectedRevisionNumber: options.expectedRevisionNumber,
  });
}

export type BulkUpdatePostInput = {
  postNumber: number;
  name?: string;
  bodyMd?: string;
  tags?: string[];
  category?: string;
  wip?: boolean;
  message?: string;
  expectedRevisionNumber?: number;
};

export type CreatePostInput = {
  name: string;
  bodyMd?: string;
  tags?: string[];
  category?: string;
  wip?: boolean;
  message?: string;
};

function createPostPayload(input: CreatePostInput) {
  return cleanUndefined({
    name: input.name,
    body_md: input.bodyMd,
    tags: input.tags,
    category: input.category,
    wip: input.wip,
    message: input.message,
  });
}

export async function createPost(options: { teamName: string; token: string; onRateLimit?: (info: EsaRateLimitInfo) => void } & CreatePostInput) {
  const post = await esaRequest<EsaPost>({
    teamName: options.teamName,
    path: "/posts",
    token: options.token,
    method: HttpMethod.Post,
    access: EsaRequestAccess.Write,
    body: { post: createPostPayload(options) },
    onRateLimit: options.onRateLimit,
  });
  return compactUpdatedPost(post);
}

export async function updatePost(options: { teamName: string; token: string } & BulkUpdatePostInput) {
  const update: Record<string, unknown> = cleanUndefined({
    name: options.name,
    body_md: options.bodyMd,
    tags: options.tags,
    category: options.category,
    wip: options.wip,
    message: options.message,
  });
  if (Object.keys(update).length === 0) {
    throw inputError("Pass at least one field to update.", "Pass at least one update field.", DomainStatus.EmptyUpdate);
  }

  let requestUpdate = update;
  if (options.expectedRevisionNumber !== undefined || Object.hasOwn(update, "body_md")) {
    const current = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber });

    if (options.expectedRevisionNumber !== undefined && current.revision_number !== options.expectedRevisionNumber) {
      throw inputError(
        `Post revision changed. Expected ${options.expectedRevisionNumber}, got ${current.revision_number ?? "unknown"}. Read the post again before updating.`,
        "Read the current post, then retry with its latest revision number.",
        DomainStatus.RevisionConflict,
      );
    }

    if (Object.hasOwn(update, "body_md")) {
      requestUpdate = {
        ...update,
        original_revision: cleanUndefined({
          body_md: current.body_md ?? "",
          number: current.revision_number,
          user: current.updated_by?.screen_name,
        }),
      };
    }
  }

  const post = await esaRequest<EsaPost>({
    teamName: options.teamName,
    path: `/posts/${options.postNumber}`,
    token: options.token,
    method: HttpMethod.Patch,
    access: EsaRequestAccess.Write,
    body: { post: requestUpdate },
  });
  return compactUpdatedPost(post);
}

function payloadByteSize(update: Record<string, unknown>): number {
  return TEXT_ENCODER.encode(JSON.stringify(update)).length;
}

const SHARED_BULK_FAILURES = new Set<DomainStatus>([
  DomainStatus.EsaAuthFailed,
  DomainStatus.EsaTokenExpired,
  DomainStatus.EsaPermissionDenied,
  DomainStatus.EsaWritePermissionRequired,
  DomainStatus.EsaRateLimited,
]);

function isSharedBulkFailure(domainStatus: DomainStatus) {
  return SHARED_BULK_FAILURES.has(domainStatus);
}

export async function bulkCreatePosts(options: { teamName: string; token: string; posts: CreatePostInput[] }) {
  if (options.posts.length === 0) {
    throw inputError("Pass at least one post to create.", "Pass one or more posts.");
  }
  if (options.posts.length > BULK_CREATE_POSTS_MAX_COUNT) {
    throw inputError(
      `Pass at most ${BULK_CREATE_POSTS_MAX_COUNT} posts per call. Got ${options.posts.length}.`,
      `Split posts into batches of ${BULK_CREATE_POSTS_MAX_COUNT} or fewer.`,
      DomainStatus.BulkCreateLimitExceeded,
    );
  }

  const prepared = options.posts.map((post, index) => ({ index, post, payload: createPostPayload(post) }));
  const totalPayloadBytes = prepared.reduce((total, item) => total + payloadByteSize(item.payload), 0);
  if (totalPayloadBytes > BULK_CREATE_TOTAL_PAYLOAD_BYTES_BUDGET) {
    throw inputError(
      `Combined post payload is ${totalPayloadBytes} bytes, over the ${BULK_CREATE_TOTAL_PAYLOAD_BYTES_BUDGET}-byte budget for one esa_bulk_create_posts call.`,
      "Split posts into smaller batches, or create large posts one at a time with esa_create_post.",
      DomainStatus.BulkCreatePayloadTooLarge,
    );
  }

  let rateLimit: EsaRateLimitInfo | undefined;
  const results: Array<Record<string, unknown>> = [];
  let abortCause: ReturnType<typeof normalizeToolError> | undefined;
  const captureRateLimit = (info: EsaRateLimitInfo) => {
    rateLimit = info;
  };

  for (const { index, post } of prepared) {
    const resultIdentity = cleanUndefined({ index, name: post.name, category: post.category });
    if (rateLimit?.remaining !== undefined && rateLimit.remaining <= 0) {
      results.push({ ...resultIdentity, status: BatchItemStatus.Skipped, error: normalizeToolError(esaRateLimitError(rateLimit.reset_at)) });
      continue;
    }
    if (abortCause) {
      results.push({
        ...resultIdentity,
        status: BatchItemStatus.Skipped,
        error: normalizeToolError(
          new ToolError({
            source: abortCause.source,
            domainStatus: DomainStatus.BulkCreateAborted,
            message: `Skipped post index ${index} because the batch was stopped after ${abortCause.domain_status}.`,
            hint: "Resolve the preceding error, then retry the posts marked skipped.",
            details: { cause_domain_status: abortCause.domain_status },
          }),
        ),
      });
      continue;
    }

    try {
      const created = await createPost({
        teamName: options.teamName,
        token: options.token,
        ...post,
        onRateLimit: captureRateLimit,
      });
      results.push({ ...resultIdentity, status: BatchItemStatus.Ok, post: created });
    } catch (error) {
      const normalized = normalizeToolError(error);
      results.push({ ...resultIdentity, status: BatchItemStatus.Error, error: normalized });
      if (isSharedBulkFailure(normalized.domain_status)) {
        abortCause = normalized;
      }
    }
  }

  const succeeded = results.filter((result) => result.status === BatchItemStatus.Ok).length;
  const failed = results.filter((result) => result.status === BatchItemStatus.Error).length;
  const skipped = results.filter((result) => result.status === BatchItemStatus.Skipped).length;
  return {
    total: results.length,
    succeeded,
    failed,
    skipped,
    total_payload_bytes: totalPayloadBytes,
    rate_limit: rateLimit,
    results,
  };
}

export async function batchMoveCategory(options: { teamName: string; token: string; from: string; to: string }) {
  if (options.from === options.to) {
    throw inputError(
      "Category source and destination are the same.",
      "Pass different category paths for from and to.",
      DomainStatus.CategoryMoveNoChange,
    );
  }
  const result = await esaRequest<Record<string, unknown>>({
    teamName: options.teamName,
    path: "/categories/batch_move",
    token: options.token,
    method: HttpMethod.Post,
    access: EsaRequestAccess.Write,
    body: { from: options.from, to: options.to },
  });
  invalidateTeamPostCache(options.teamName);
  return result;
}

export async function bulkUpdatePosts(options: { teamName: string; token: string; posts: BulkUpdatePostInput[] }) {
  if (options.posts.length === 0) {
    throw inputError("Pass at least one post to update.", "Pass one or more posts.");
  }
  if (options.posts.length > BULK_UPDATE_POSTS_MAX_COUNT) {
    throw inputError(
      `Pass at most ${BULK_UPDATE_POSTS_MAX_COUNT} posts per call. Got ${options.posts.length}.`,
      `Split posts into batches of ${BULK_UPDATE_POSTS_MAX_COUNT} or fewer.`,
      DomainStatus.BulkUpdateLimitExceeded,
    );
  }

  // First pass: build each post's update body and validate the whole batch
  // before sending anything, so an oversized or malformed request fails
  // fast instead of partway through a run of esa writes.
  const seenPostNumbers = new Set<number>();
  const prepared: { postNumber: number; update: Record<string, unknown>; expectedRevisionNumber?: number }[] = [];
  let totalPayloadBytes = 0;

  for (const item of options.posts) {
    if (seenPostNumbers.has(item.postNumber)) {
      throw inputError(
        `post_number ${item.postNumber} appears more than once in posts.`,
        "Each post_number in posts must be unique.",
        DomainStatus.BulkDuplicatePostNumber,
      );
    }
    seenPostNumbers.add(item.postNumber);

    const update = cleanUndefined({
      name: item.name,
      body_md: item.bodyMd,
      tags: item.tags,
      category: item.category,
      wip: item.wip,
      message: item.message,
    });
    prepared.push({ postNumber: item.postNumber, update, expectedRevisionNumber: item.expectedRevisionNumber });
    totalPayloadBytes += payloadByteSize(update);
  }

  // The item-count cap above is deliberately generous; what actually makes a
  // bulk call slow to send is total payload size, so enforce that directly
  // instead of a tighter fixed count. Large bodies push the effective count
  // for one call back down without penalizing many small metadata-only edits
  // (retag, recategorize, wip toggles) that stay well under the budget.
  if (totalPayloadBytes > BULK_UPDATE_TOTAL_PAYLOAD_BYTES_BUDGET) {
    throw inputError(
      `Combined post payload is ${totalPayloadBytes} bytes, over the ${BULK_UPDATE_TOTAL_PAYLOAD_BYTES_BUDGET}-byte budget for one esa_bulk_update_posts call.`,
      "Split posts into smaller batches, or update large bodies one at a time with esa_update_post or esa_patch_post.",
      DomainStatus.BulkPayloadTooLarge,
    );
  }

  // Keep writes ordered and stop shared failures from generating repeated requests.
  let rateLimit: EsaRateLimitInfo | undefined;
  const results: Array<Record<string, unknown>> = [];
  let abortCause: ReturnType<typeof normalizeToolError> | undefined;

  const captureRateLimit = (info: EsaRateLimitInfo) => {
    rateLimit = info;
  };

  for (const { postNumber, update, expectedRevisionNumber } of prepared) {
    if (rateLimit?.remaining !== undefined && rateLimit.remaining <= 0) {
      results.push({
        post_number: postNumber,
        status: BatchItemStatus.Skipped,
        error: normalizeToolError(esaRateLimitError(rateLimit.reset_at)),
      });
      continue;
    }

    if (abortCause) {
      results.push({
        post_number: postNumber,
        status: BatchItemStatus.Skipped,
        error: normalizeToolError(
          new ToolError({
            source: abortCause.source,
            domainStatus: DomainStatus.BulkUpdateAborted,
            message: `Skipped post_number ${postNumber} because the batch was stopped after ${abortCause.domain_status}.`,
            hint: "Resolve the preceding error, then retry the posts marked skipped.",
            details: { cause_domain_status: abortCause.domain_status },
          }),
        ),
      });
      continue;
    }

    if (Object.keys(update).length === 0) {
      results.push({
        post_number: postNumber,
        status: BatchItemStatus.Error,
        error: normalizeToolError(
          inputError(`post_number ${postNumber}: pass at least one field to update.`, "Pass at least one update field.", DomainStatus.EmptyUpdate),
        ),
      });
      continue;
    }

    try {
      let requestUpdate = update;
      if (expectedRevisionNumber !== undefined || Object.hasOwn(update, "body_md")) {
        const current = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: postNumber, onRateLimit: captureRateLimit });

        if (expectedRevisionNumber !== undefined && current.revision_number !== expectedRevisionNumber) {
          throw inputError(
            `Post revision changed. Expected ${expectedRevisionNumber}, got ${current.revision_number ?? "unknown"}. Read the post again before updating.`,
            "Read the current post, then retry with its latest revision number.",
            DomainStatus.RevisionConflict,
          );
        }

        if (rateLimit?.remaining !== undefined && rateLimit.remaining <= 0) {
          results.push({
            post_number: postNumber,
            status: BatchItemStatus.Skipped,
            error: normalizeToolError(esaRateLimitError(rateLimit.reset_at)),
          });
          continue;
        }

        if (Object.hasOwn(update, "body_md")) {
          requestUpdate = {
            ...update,
            original_revision: cleanUndefined({
              body_md: current.body_md ?? "",
              number: current.revision_number,
              user: current.updated_by?.screen_name,
            }),
          };
        }
      }

      const post = await esaRequest<EsaPost>({
        teamName: options.teamName,
        path: `/posts/${postNumber}`,
        token: options.token,
        method: HttpMethod.Patch,
        access: EsaRequestAccess.Write,
        body: { post: requestUpdate },
        onRateLimit: captureRateLimit,
      });
      results.push({
        post_number: postNumber,
        status: BatchItemStatus.Ok,
        post: compactUpdatedPost(post),
      });
    } catch (error) {
      const normalized = normalizeToolError(error);
      results.push({
        post_number: postNumber,
        status: BatchItemStatus.Error,
        error: normalized,
      });
      if (isSharedBulkFailure(normalized.domain_status)) {
        abortCause = normalized;
      }
    }
  }

  const succeeded = results.filter((result) => result.status === BatchItemStatus.Ok).length;
  const failed = results.filter((result) => result.status === BatchItemStatus.Error).length;
  const skipped = results.filter((result) => result.status === BatchItemStatus.Skipped).length;

  return {
    total: results.length,
    succeeded,
    failed,
    skipped,
    total_payload_bytes: totalPayloadBytes,
    rate_limit: rateLimit,
    results,
  };
}

export async function appendPost(options: {
  teamName: string;
  token: string;
  postNumber: number;
  bodyMd: string;
  heading?: string;
  occurrence?: number;
  headingLevel?: number;
  separator?: string;
  expectedRevisionNumber?: number;
  message?: string;
}) {
  const post = await fetchPost({ teamName: options.teamName, token: options.token, postNumber: options.postNumber });
  const body = post.body_md ?? "";
  const separator = options.separator ?? "\n\n";
  const appendText = options.bodyMd.trim();
  if (!appendText) {
    throw inputError("body_md is required.", "Pass non-empty body_md.", DomainStatus.BodyRequired);
  }

  let nextBody: string;
  if (options.heading) {
    const section = findSection(body, options.heading, options.occurrence, options.headingLevel);
    const sectionBody = body.slice(section.contentStart, section.end).trimEnd();
    const replacement = `${sectionBody}${separator}${appendText}\n\n`;
    nextBody = `${body.slice(0, section.contentStart)}${replacement}${body.slice(section.end)}`;
  } else {
    nextBody = `${body.trimEnd()}${separator}${appendText}\n`;
  }

  return updatePostBody({
    teamName: options.teamName,
    token: options.token,
    postNumber: options.postNumber,
    post,
    bodyMd: nextBody,
    message: options.message,
    expectedRevisionNumber: options.expectedRevisionNumber,
  });
}
