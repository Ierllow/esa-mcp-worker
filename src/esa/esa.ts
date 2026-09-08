// Keep existing imports stable while the esa implementation is split by responsibility.
export {
  cleanUndefined,
  compactUpdatedPost,
  describeEsaValidationTarget,
  esaGet,
  esaRequest,
  firstPostNumber,
  requireWriteConfirmation,
  resolveContextEntryPostNumber,
  resolveContextObserverPostNumber,
  resolveContextSummaryPostNumber,
  resolveTeamName,
  resolveValidationPostNumber,
  validateEsaReadAccess,
  type EsaPost,
} from "./esa-api";

export {
  CONTEXT_PREFETCH_MAX_COUNT,
  DEFAULT_CONTEXT_ENTRY_MAX_CHARS,
  DEFAULT_CONTEXT_PREFETCH_MAX_CHARS,
  DEFAULT_CONTEXT_SUMMARY_MAX_CHARS,
  DEFAULT_MODEL_READ_MAX_CHARS,
  MAX_MODEL_READ_MAX_CHARS,
  MODEL_READ_POSTS_MAX_COUNT,
  POST_SECTIONS_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
  getPostModelView,
  getPostCollection,
  getPostsModelView,
  loadContextEntry,
  readPostSections,
  searchPostsLightweight,
  searchPostsMulti,
  type ContextPrefetchInput,
  type SearchQueryInput,
} from "./esa-read";

export { runEsaCommand } from "./esa-command";

export { checkContextDrift, refreshContextObserver } from "./esa-observer";

export {
  BULK_CREATE_POSTS_MAX_COUNT,
  BULK_CREATE_TOTAL_PAYLOAD_BYTES_BUDGET,
  BULK_UPDATE_POSTS_MAX_COUNT,
  BULK_UPDATE_TOTAL_PAYLOAD_BYTES_BUDGET,
  appendPost,
  batchMoveCategory,
  bulkCreatePosts,
  bulkUpdatePosts,
  createPost,
  patchPost,
  patchPostSections,
  updatePost,
  type BulkUpdatePostInput,
  type CreatePostInput,
} from "./esa-write";
