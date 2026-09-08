import { z } from "zod";
import { EsaRequestAccess, HttpMethod, OperationStatus, PostPatchType } from "../core/constants";
import { createWriteResult } from "../core/utils";
import {
  BULK_CREATE_POSTS_MAX_COUNT,
  BULK_CREATE_TOTAL_PAYLOAD_BYTES_BUDGET,
  BULK_UPDATE_POSTS_MAX_COUNT,
  BULK_UPDATE_TOTAL_PAYLOAD_BYTES_BUDGET,
  POST_SECTIONS_MAX_COUNT,
  appendPost,
  bulkCreatePosts,
  bulkUpdatePosts,
  cleanUndefined,
  createPost,
  esaRequest,
  patchPost,
  patchPostSections,
  refreshContextObserver,
  resolveContextObserverPostNumber,
  updatePost,
} from "../esa/esa";
import {
  CONFIRM_WRITE_SCHEMA,
  EXPECTED_REVISION_NUMBER_SCHEMA,
  HEADING_LEVEL_SCHEMA,
  HEADING_SCHEMA,
  OCCURRENCE_SCHEMA,
  OPTIONAL_TEAM_NAME_SCHEMA,
  POST_CATEGORY_SCHEMA,
  POST_NUMBER_SCHEMA,
  POST_TAGS_SCHEMA,
  REVISION_MESSAGE_SCHEMA,
  WRITE_TOOL_ANNOTATIONS,
  WRITE_TOOL_META,
} from "./mcp-static";
import type { McpRegistration } from "./mcp-registration";

export function registerWriteTools({ esaTool, env, token, syncObserver }: McpRegistration) {
  const writeToolAnnotations = WRITE_TOOL_ANNOTATIONS;
  const writeToolMeta = WRITE_TOOL_META;
  esaTool(
    "esa_create_post",
    {
      title: "Create esa Post",
      annotations: writeToolAnnotations,
      description: "Create an esa post. Requires an esa token with write scope and confirm_write=true. A completed result needs no follow-up read.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        name: z.string().min(1).describe("Post title/path."),
        body_md: z.string().default("").describe("Markdown body."),
        tags: POST_TAGS_SCHEMA,
        category: POST_CATEGORY_SCHEMA,
        wip: z.boolean().optional().describe("Whether to create as WIP."),
        message: REVISION_MESSAGE_SCHEMA,
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    () => ({ target: "post:new" }),
    async ({ name, body_md: bodyMd, tags, category, wip, message }, teamName) => {
      const post = await createPost({
        teamName,
        token,
        name,
        bodyMd,
        tags,
        category,
        wip,
        message,
      });
      return createWriteResult("post_created", post);
    },
  );

  esaTool(
    "esa_bulk_create_posts",
    {
      title: "Bulk Create esa Posts",
      annotations: writeToolAnnotations,
      description: `Create up to ${BULK_CREATE_POSTS_MAX_COUNT} esa posts in order, within a ${Math.round(BULK_CREATE_TOTAL_PAYLOAD_BYTES_BUDGET / 1024)}KB combined payload. Post-specific errors do not stop the batch; shared authentication, permission, or rate-limit failures skip the remaining posts. Requires write scope and confirm_write=true. A completed result needs no follow-up read.`,
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        posts: z
          .array(
            z.object({
              name: z.string().min(1).describe("Post title/path."),
              body_md: z.string().default("").describe("Markdown body."),
              tags: POST_TAGS_SCHEMA,
              category: POST_CATEGORY_SCHEMA,
              wip: z.boolean().optional().describe("Whether to create as WIP."),
              message: REVISION_MESSAGE_SCHEMA,
            }),
          )
          .min(1)
          .max(BULK_CREATE_POSTS_MAX_COUNT)
          .describe(
            `Posts to create in order, ${BULK_CREATE_POSTS_MAX_COUNT} at most and their combined payload under ${Math.round(BULK_CREATE_TOTAL_PAYLOAD_BYTES_BUDGET / 1024)}KB.`,
          ),
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    (args) => ({ target: `posts:new:${args.posts.length}` }),
    async ({ posts }, teamName) => {
      const result = await bulkCreatePosts({
        teamName,
        token,
        posts: posts.map((post) => ({
          name: post.name,
          bodyMd: post.body_md,
          tags: post.tags,
          category: post.category,
          wip: post.wip,
          message: post.message,
        })),
      });
      return createWriteResult(
        "posts_created",
        result,
        result.failed === 0 && result.skipped === 0 ? OperationStatus.Completed : OperationStatus.Partial,
      );
    },
  );

  esaTool(
    "esa_update_post",
    {
      title: "Update esa Post",
      annotations: writeToolAnnotations,
      description: "Update an esa post. Requires an esa token with write scope and confirm_write=true. A completed result needs no follow-up read.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        post_number: POST_NUMBER_SCHEMA,
        name: z.string().min(1).optional().describe("New post title/path."),
        body_md: z.string().optional().describe("New markdown body."),
        tags: z.array(z.string().min(1)).optional().describe("Replacement tags."),
        category: z.string().min(1).optional().describe("New category path."),
        wip: z.boolean().optional().describe("Whether the post should be WIP."),
        message: REVISION_MESSAGE_SCHEMA,
        expected_revision_number: EXPECTED_REVISION_NUMBER_SCHEMA,
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    (args) => ({ target: `post:${args.post_number}` }),
    async ({ post_number: postNumber, name, body_md: bodyMd, tags, category, wip, message, expected_revision_number: expectedRevisionNumber, }, teamName) => {
      const post = await updatePost({
        teamName,
        token,
        postNumber,
        name,
        bodyMd,
        tags,
        category,
        wip,
        message,
        expectedRevisionNumber,
      });
      syncObserver(teamName, [post]);
      return createWriteResult("post_updated", post);
    },
  );

  esaTool(
    "esa_bulk_update_posts",
    {
      title: "Bulk Update esa Posts",
      annotations: writeToolAnnotations,
      description: `Update up to ${BULK_UPDATE_POSTS_MAX_COUNT} esa posts in order, within a ${Math.round(BULK_UPDATE_TOTAL_PAYLOAD_BYTES_BUDGET / 1024)}KB combined payload. Post-specific errors do not stop the batch; shared authentication, permission, or rate-limit failures skip the remaining posts. Body replacements use esa original_revision data. Requires write scope and confirm_write=true. A completed result needs no follow-up read.`,
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        posts: z
          .array(
            z.object({
              post_number: POST_NUMBER_SCHEMA,
              name: z.string().min(1).optional().describe("New post title/path."),
              body_md: z.string().optional().describe("New markdown body."),
              tags: z.array(z.string().min(1)).optional().describe("Replacement tags."),
              category: z.string().min(1).optional().describe("New category path."),
              wip: z.boolean().optional().describe("Whether the post should be WIP."),
              message: REVISION_MESSAGE_SCHEMA,
              expected_revision_number: EXPECTED_REVISION_NUMBER_SCHEMA,
            }),
          )
          .min(1)
          .max(BULK_UPDATE_POSTS_MAX_COUNT)
          .describe(
            `Posts to update, ${BULK_UPDATE_POSTS_MAX_COUNT} at most and their combined payload under ${Math.round(BULK_UPDATE_TOTAL_PAYLOAD_BYTES_BUDGET / 1024)}KB. Each post_number must be unique and each entry needs at least one field to update.`,
          ),
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    (args) => ({ target: `posts:${args.posts.map((post) => post.post_number).join(",")}` }),
    async ({ posts }, teamName) => {
      const result = await bulkUpdatePosts({
        teamName,
        token,
        posts: posts.map((post) => ({
          postNumber: post.post_number,
          name: post.name,
          bodyMd: post.body_md,
          tags: post.tags,
          category: post.category,
          wip: post.wip,
          message: post.message,
          expectedRevisionNumber: post.expected_revision_number,
        })),
      });
      syncObserver(
        teamName,
        result.results.map((item) => item.post),
      );
      return createWriteResult(
        "posts_updated",
        result,
        result.failed === 0 && result.skipped === 0 ? OperationStatus.Completed : OperationStatus.Partial,
      );
    },
  );

  esaTool(
    "esa_patch_post",
    {
      title: "Patch esa Post",
      annotations: writeToolAnnotations,
      description:
        "Patch part of an esa post. Supports replacing one heading section or one text occurrence. Requires write scope and confirm_write=true. A completed result needs no follow-up read.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        post_number: POST_NUMBER_SCHEMA,
        patch_type: z.enum(PostPatchType).describe("Patch mode."),
        heading: z.string().min(1).optional().describe("Required for replace_section."),
        section_body_md: z.string().optional().describe("Replacement section body without the heading line."),
        old_text: z.string().optional().describe("Required for replace_text."),
        new_text: z.string().optional().describe("Required for replace_text."),
        occurrence: z.number().int().positive().optional().describe("Use when the heading or old_text appears multiple times."),
        heading_level: z.number().int().min(1).max(6).optional().describe("Optional markdown heading level for replace_section."),
        expected_revision_number: EXPECTED_REVISION_NUMBER_SCHEMA,
        message: REVISION_MESSAGE_SCHEMA,
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    (args) => ({ target: `post:${args.post_number}` }),
    async ({ post_number: postNumber, patch_type: patchType, heading, section_body_md: sectionBodyMd, old_text: oldText, new_text: newText, occurrence, heading_level: headingLevel, expected_revision_number: expectedRevisionNumber, message, }, teamName) => {
      const post = await patchPost({
        teamName,
        token,
        postNumber,
        patchType,
        heading,
        sectionBodyMd,
        oldText,
        newText,
        occurrence,
        headingLevel,
        expectedRevisionNumber,
        message,
      });
      syncObserver(teamName, [post]);
      return createWriteResult("post_patched", post);
    },
  );

  esaTool(
    "esa_patch_sections",
    {
      title: "Patch esa Sections",
      annotations: writeToolAnnotations,
      description: "Replace multiple non-overlapping heading sections in one esa post update. Requires write scope and confirm_write=true. A completed result needs no follow-up read.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        post_number: POST_NUMBER_SCHEMA,
        sections: z
          .array(
            z.object({
              heading: HEADING_SCHEMA,
              section_body_md: z.string().describe("Replacement section body without the heading line."),
              occurrence: OCCURRENCE_SCHEMA,
              heading_level: HEADING_LEVEL_SCHEMA,
            }),
          )
          .min(1)
          .max(POST_SECTIONS_MAX_COUNT)
          .describe("Sections to replace."),
        expected_revision_number: EXPECTED_REVISION_NUMBER_SCHEMA,
        message: REVISION_MESSAGE_SCHEMA,
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    (args) => ({ target: `post:${args.post_number}` }),
    async ({ post_number: postNumber, sections, expected_revision_number: expectedRevisionNumber, message }, teamName) => {
      const post = await patchPostSections({
        teamName,
        token,
        postNumber,
        sections: sections.map((section) => ({
          heading: section.heading,
          sectionBodyMd: section.section_body_md,
          occurrence: section.occurrence,
          headingLevel: section.heading_level,
        })),
        expectedRevisionNumber,
        message,
      });
      syncObserver(teamName, [post]);
      return createWriteResult("post_sections_patched", post);
    },
  );

  esaTool(
    "esa_refresh_context_observer",
    {
      title: "Refresh esa Context Observer",
      annotations: writeToolAnnotations,
      description:
        "Accept current esa revisions into the Cloudflare KV context observer. The legacy observer post is read only for a one-time migration when KV is empty. Requires confirm_write=true.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        observer_post_number: z.number().int().positive().optional().describe("Legacy esa observer post used only for one-time KV migration."),
        post_numbers: z.array(z.number().int().positive()).min(1).max(50).optional().describe("Optional subset of observed post numbers to refresh."),
        confirm_write: z.boolean().describe("Must be true to update the observer baseline."),
      }),
    },
    () => ({ target: "context:observer" }),
    async ({ observer_post_number: observerPostNumber, post_numbers: postNumbers }, teamName) => {
      const result = await refreshContextObserver({
        env,
        teamName,
        token,
        observerPostNumber: resolveContextObserverPostNumber(observerPostNumber, env),
        postNumbers,
      });
      return createWriteResult("context_observer_refreshed", result);
    },
  );

  esaTool(
    "esa_append_post",
    {
      title: "Append esa Post",
      annotations: writeToolAnnotations,
      description: "Append markdown to the end of a post or to one heading section. Requires write scope and confirm_write=true. A completed result needs no follow-up read.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        post_number: POST_NUMBER_SCHEMA,
        body_md: z.string().min(1).describe("Markdown to append."),
        heading: z.string().min(1).optional().describe("Optional heading to append inside."),
        occurrence: OCCURRENCE_SCHEMA,
        heading_level: HEADING_LEVEL_SCHEMA,
        separator: z.string().max(20).optional().describe("Separator inserted before appended markdown. Defaults to a blank line."),
        expected_revision_number: EXPECTED_REVISION_NUMBER_SCHEMA,
        message: REVISION_MESSAGE_SCHEMA,
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    (args) => ({ target: `post:${args.post_number}` }),
    async ({ post_number: postNumber, body_md: bodyMd, heading, occurrence, heading_level: headingLevel, separator, expected_revision_number: expectedRevisionNumber, message, }, teamName) => {
      const post = await appendPost({
        teamName,
        token,
        postNumber,
        bodyMd,
        heading,
        occurrence,
        headingLevel,
        separator,
        expectedRevisionNumber,
        message,
      });
      syncObserver(teamName, [post]);
      return createWriteResult("post_appended", post);
    },
  );

  esaTool(
    "esa_create_comment",
    {
      title: "Create esa Comment",
      annotations: writeToolAnnotations,
      description: "Create a comment on an esa post. Requires an esa token with write scope and confirm_write=true. A completed result needs no follow-up read.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        post_number: POST_NUMBER_SCHEMA,
        body_md: z.string().min(1).describe("Comment markdown body."),
        confirm_write: CONFIRM_WRITE_SCHEMA,
      }),
    },
    (args) => ({ target: `post:${args.post_number}` }),
    async ({ post_number: postNumber, body_md: bodyMd }, teamName) => {
      const comment = await esaRequest({
        teamName,
        path: `/posts/${postNumber}/comments`,
        token,
        method: HttpMethod.Post,
        access: EsaRequestAccess.Write,
        body: { comment: { body_md: bodyMd } },
      });
      const compactComment = comment as Record<string, unknown>;
      return createWriteResult(
        "comment_created",
        cleanUndefined({
          number: compactComment.number,
          url: compactComment.url,
          created_at: compactComment.created_at,
          updated_at: compactComment.updated_at,
        }),
      );
    },
  );
}
