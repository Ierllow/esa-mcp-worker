import { EsaRequestAccess, HttpMethod, HttpStatusCode, SensitiveKeyFragment } from "./constants";
import { hintJaFor, messageJaFor } from "./error-catalog";

export enum ErrorSource {
  EsaApi = "esa_api",
  ServerConfig = "server_config",
  Input = "input",
  WriteConfirmation = "write_confirmation",
  GithubApi = "github_api",
  Cloudflare = "cloudflare",
  Unexpected = "unexpected",
}

export enum DomainStatus {
  EsaAuthFailed = "esa_auth_failed",
  EsaTokenExpired = "esa_token_expired",
  EsaPermissionDenied = "esa_permission_denied",
  EsaWritePermissionRequired = "esa_write_permission_required",
  EsaPostNotFound = "esa_post_not_found",
  EsaResourceNotFound = "esa_resource_not_found",
  EsaTeamOrEndpointNotFound = "esa_team_or_endpoint_not_found",
  EsaRevisionConflict = "esa_revision_conflict",
  RevisionConflict = "revision_conflict",
  EsaValidationFailed = "esa_validation_failed",
  EsaRateLimited = "esa_rate_limited",
  EsaUnavailable = "esa_unavailable",
  EsaRequestFailed = "esa_request_failed",
  WriteConfirmationRequired = "write_confirmation_required",
  ServerConfigMissing = "server_config_missing",
  TeamRequired = "team_required",
  ObserverRequired = "observer_required",
  ObserverJsonMissing = "observer_json_missing",
  ObserverJsonInvalid = "observer_json_invalid",
  RegistryRequired = "registry_required",
  RegistryYamlMissing = "registry_yaml_missing",
  RegistryYamlInvalid = "registry_yaml_invalid",
  InvalidInput = "invalid_input",
  EmptyUpdate = "empty_update",
  BulkCreateLimitExceeded = "bulk_create_limit_exceeded",
  BulkCreatePayloadTooLarge = "bulk_create_payload_too_large",
  BulkCreateAborted = "bulk_create_aborted",
  BulkUpdateLimitExceeded = "bulk_update_limit_exceeded",
  MultiSearchLimitExceeded = "multi_search_limit_exceeded",
  BulkDuplicatePostNumber = "bulk_duplicate_post_number",
  BulkPayloadTooLarge = "bulk_payload_too_large",
  BulkUpdateAborted = "bulk_update_aborted",
  CategoryMoveNoChange = "category_move_no_change",
  BodyRequired = "body_required",
  SearchQueryRequired = "search_query_required",
  CommandTargetNotFound = "command_target_not_found",
  HeadingRequired = "heading_required",
  SectionBodyRequired = "section_body_required",
  PatchTextRequired = "patch_text_required",
  SectionNotFound = "section_not_found",
  PatchTargetNotFound = "patch_target_not_found",
  PatchTargetAmbiguous = "patch_target_ambiguous",
  PatchNoChange = "patch_no_change",
  SectionPatchOverlap = "section_patch_overlap",
  GithubNotConnected = "github_not_connected",
  GithubAppConfigInvalid = "github_app_config_invalid",
  GithubAppTokenFailed = "github_app_token_failed",
  GithubAuthFailed = "github_auth_failed",
  GithubPermissionDenied = "github_permission_denied",
  GithubRepositoryNotFound = "github_repository_not_found",
  GithubResourceNotFound = "github_resource_not_found",
  GithubRefConflict = "github_ref_conflict",
  GithubFileConflict = "github_file_conflict",
  GithubProtectedPath = "github_protected_path",
  GithubPayloadTooLarge = "github_payload_too_large",
  GithubValidationPending = "github_validation_pending",
  GithubValidationFailed = "github_validation_failed",
  GithubValidationMissing = "github_validation_missing",
  GithubPublishConflict = "github_publish_conflict",
  GithubApiFailed = "github_api_failed",
  ToolFailed = "tool_failed",
  CloudflareKvWriteBlocked = "cloudflare_kv_write_blocked",
  CloudflareRuntimeError = "cloudflare_runtime_error",
  ServerUnexpectedError = "server_unexpected_error",
}

export type ToolErrorPayload = {
  source: ErrorSource;
  domain_status: DomainStatus;
  message: string;
  message_ja: string;
  hint?: string;
  hint_ja?: string;
  http_status?: number;
  details?: Record<string, unknown>;
};

type ToolErrorOptions = {
  source: ErrorSource;
  domainStatus: DomainStatus;
  message: string;
  messageJa?: string;
  hint?: string;
  hintJa?: string;
  status?: number;
  details?: Record<string, unknown>;
};

export class ToolError extends Error {
  source: ErrorSource;
  domainStatus: DomainStatus;
  messageJa?: string;
  hint?: string;
  hintJa?: string;
  status?: number;
  details?: Record<string, unknown>;

  constructor(options: ToolErrorOptions) {
    super(options.message);
    this.name = "ToolError";
    this.source = options.source;
    this.domainStatus = options.domainStatus;
    this.messageJa = options.messageJa;
    this.hint = options.hint;
    this.hintJa = options.hintJa;
    this.status = options.status;
    this.details = options.details;
  }
}

export function normalizeToolError(error: unknown): ToolErrorPayload {
  if (error instanceof ToolError) {
    return cleanPayload({
      source: error.source,
      domain_status: error.domainStatus,
      message: error.message,
      message_ja: error.messageJa ?? messageJaFor(error.domainStatus, error.message),
      hint: error.hint,
      hint_ja: error.hintJa ?? hintJaFor(error.domainStatus),
      http_status: error.status ?? inferHttpStatus(error.message, error.domainStatus),
      details: sanitizeDetails(error.details),
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const domainStatus = inferDomainStatus(message);
  return cleanPayload({
    source: inferSource(message),
    domain_status: domainStatus,
    message,
    message_ja: messageJaFor(domainStatus, message),
    hint: inferHint(message),
    hint_ja: hintJaFor(domainStatus),
    http_status: inferHttpStatus(message, domainStatus),
  });
}

export function esaApiError(options: {
  status: number;
  statusText: string;
  method: HttpMethod;
  access: EsaRequestAccess;
  path: string;
  body: unknown;
}) {
  const domainStatus = esaStatusDomainStatus(options.status, options.access, options.path, options.body);
  return new ToolError({
    source: ErrorSource.EsaApi,
    domainStatus,
    message: `esa API request failed: ${options.status} ${options.statusText}`,
    hint: esaStatusHint(options.status),
    status: options.status,
    details: {
      method: options.method,
      path: options.path,
      status_text: options.statusText,
      response: sanitizeValue(options.body),
    },
  });
}

export function inputError(message: string, hint?: string, domainStatus: DomainStatus = DomainStatus.InvalidInput) {
  return new ToolError({
    source: ErrorSource.Input,
    domainStatus,
    message,
    hint,
  });
}

export function serverConfigError(message: string, hint?: string, domainStatus: DomainStatus = DomainStatus.ServerConfigMissing) {
  return new ToolError({
    source: ErrorSource.ServerConfig,
    domainStatus,
    message,
    hint,
  });
}

export function writeConfirmationError() {
  return new ToolError({
    source: ErrorSource.WriteConfirmation,
    domainStatus: DomainStatus.WriteConfirmationRequired,
    message: "Set confirm_write to true to perform this esa write operation.",
    hint: "Write tools require explicit confirm_write: true.",
  });
}

export function domainError(message: string, domainStatus: DomainStatus, hint?: string, details?: Record<string, unknown>) {
  return new ToolError({
    source: ErrorSource.Input,
    domainStatus,
    message,
    hint,
    details,
  });
}

export function esaRateLimitError(resetAt?: string) {
  return new ToolError({
    source: ErrorSource.EsaApi,
    domainStatus: DomainStatus.EsaRateLimited,
    message: `esa API rate limit is exhausted${resetAt ? ` until ${resetAt}` : ""}.`,
    hint: "Wait for the rate limit window to reset, then retry the remaining requests.",
    status: HttpStatusCode.TooManyRequests,
    details: resetAt ? { reset_at: resetAt } : undefined,
  });
}

function inferSource(message: string): ErrorSource {
  switch (true) {
    case isCloudflareKvWriteBlockedMessage(message) || /Cloudflare|Workers runtime|Worker threw/i.test(message):
      return ErrorSource.Cloudflare;
    case /esa API request failed/i.test(message):
      return ErrorSource.EsaApi;
    case /confirm_write/i.test(message):
      return ErrorSource.WriteConfirmation;
    case /is required|must be|not found|appears multiple times|Pass at least one field/i.test(message):
      return ErrorSource.Input;
    case /is not configured/i.test(message):
      return ErrorSource.ServerConfig;
    default:
      return ErrorSource.Unexpected;
  }
}

function inferDomainStatus(message: string): DomainStatus {
  switch (true) {
    case isCloudflareKvWriteBlockedMessage(message):
      return DomainStatus.CloudflareKvWriteBlocked;
    case /Cloudflare|Workers runtime|Worker threw/i.test(message):
      return DomainStatus.CloudflareRuntimeError;
    case /confirm_write/i.test(message):
      return DomainStatus.WriteConfirmationRequired;
    case /team_name is required/i.test(message):
      return DomainStatus.TeamRequired;
    case /observer_post_number is required/i.test(message):
      return DomainStatus.ObserverRequired;
    case /Context observer post must contain a JSON code block/i.test(message):
      return DomainStatus.ObserverJsonMissing;
    case /Context observer JSON is invalid/i.test(message):
      return DomainStatus.ObserverJsonInvalid;
    case /Pass at least one field to update/i.test(message):
      return DomainStatus.EmptyUpdate;
    case /body_md is required/i.test(message):
      return DomainStatus.BodyRequired;
    case /Search command requires a query/i.test(message):
      return DomainStatus.SearchQueryRequired;
    case /Could not find a post number/i.test(message):
      return DomainStatus.CommandTargetNotFound;
    case /heading is required/i.test(message):
      return DomainStatus.HeadingRequired;
    case /section_body_md is required/i.test(message):
      return DomainStatus.SectionBodyRequired;
    case /old_text is required|old_text and new_text are required/i.test(message):
      return DomainStatus.PatchTextRequired;
    case /Heading not found/i.test(message):
      return DomainStatus.SectionNotFound;
    case /old_text was not found|old_text occurrence .* was not found/i.test(message):
      return DomainStatus.PatchTargetNotFound;
    case /old_text appears multiple times/i.test(message):
      return DomainStatus.PatchTargetAmbiguous;
    case /Patch did not change/i.test(message):
      return DomainStatus.PatchNoChange;
    case /Section patches must not overlap/i.test(message):
      return DomainStatus.SectionPatchOverlap;
    case /expected_revision_number/i.test(message):
      return DomainStatus.RevisionConflict;
    case /is not configured/i.test(message):
      return DomainStatus.ServerConfigMissing;
    default:
      return DomainStatus.ServerUnexpectedError;
  }
}

function inferHint(message: string) {
  switch (true) {
    case isCloudflareKvWriteBlockedMessage(message):
      return "Workers KV write quota was reached. Wait for the daily reset, reduce audit writes, or upgrade the Workers plan.";
    case /Cloudflare|Workers runtime|Worker threw/i.test(message):
      return "Check Cloudflare Worker logs and bindings. If KV is blocked, wait for reset or reduce write operations.";
    case /team_name is required/i.test(message):
      return "Pass team_name or configure ESA_DEFAULT_TEAM.";
    case /confirm_write/i.test(message):
      return "Pass confirm_write: true only after the write is intended.";
    case /Heading not found/i.test(message):
      return "Check the outline first, then pass the exact heading text and occurrence if needed.";
    case /old_text appears multiple times/i.test(message):
      return "Pass occurrence to choose which matching text to replace.";
    case /expected_revision_number/i.test(message):
      return "Read the current compact post or section, then retry with the latest revision.";
    case /Invalid URL|URL is invalid/i.test(message):
      return "Check that the URL includes a valid https:// scheme and host.";
    default:
      return undefined;
  }
}

function inferHttpStatus(message: string, domainStatus: DomainStatus) {
  switch (true) {
    case isCloudflareKvWriteBlockedMessage(message):
      return HttpStatusCode.ServiceUnavailable;
    case domainStatus === DomainStatus.ServerConfigMissing:
    case domainStatus === DomainStatus.ServerUnexpectedError:
    case domainStatus === DomainStatus.CloudflareRuntimeError:
      return HttpStatusCode.InternalServerError;
    default:
      return undefined;
  }
}

function isCloudflareKvWriteBlockedMessage(message: string) {
  return /(?:Workers KV|KVNamespace|KV PUT|KV put|MCP_CONFIG|put operation|put values)/i.test(message)
    && /(?:429|Too Many Requests|quota|limit|exceeded|temporarily blocked|rate limit)/i.test(message);
}

function esaStatusDomainStatus(status: number, access: EsaRequestAccess, path: string, body: unknown): DomainStatus {
  const bodyText = stringifyBody(body);
  switch (status) {
    case HttpStatusCode.Unauthorized:
      return /expired/i.test(bodyText) ? DomainStatus.EsaTokenExpired : DomainStatus.EsaAuthFailed;
    case HttpStatusCode.Forbidden:
      return access === EsaRequestAccess.Read ? DomainStatus.EsaPermissionDenied : DomainStatus.EsaWritePermissionRequired;
    case HttpStatusCode.NotFound:
      if (/^\/posts\/\d+/.test(path)) {
        return DomainStatus.EsaPostNotFound;
      }
      return path.startsWith("/posts") ? DomainStatus.EsaResourceNotFound : DomainStatus.EsaTeamOrEndpointNotFound;
    case HttpStatusCode.Conflict:
      return DomainStatus.EsaRevisionConflict;
    case HttpStatusCode.UnprocessableEntity:
      return DomainStatus.EsaValidationFailed;
    case HttpStatusCode.TooManyRequests:
      return DomainStatus.EsaRateLimited;
    default:
      return status >= HttpStatusCode.InternalServerError ? DomainStatus.EsaUnavailable : DomainStatus.EsaRequestFailed;
  }
}

function esaStatusHint(status: number) {
  switch (status) {
    case HttpStatusCode.Unauthorized:
      return "esa token is invalid or expired. Reconnect OAuth with a valid esa access token.";
    case HttpStatusCode.Forbidden:
      return "esa token lacks permission for this team or operation. Check token scope and team_name.";
    case HttpStatusCode.NotFound:
      return "The esa team, post, or endpoint was not found. Check team_name and post_number.";
    case HttpStatusCode.UnprocessableEntity:
      return "esa rejected the request body. Check required fields, write scope, and revision guard.";
    case HttpStatusCode.TooManyRequests:
      return "esa rate limit was reached. Wait briefly and retry.";
    default:
      return status >= HttpStatusCode.InternalServerError
        ? "esa API returned a server error. Retry later or check esa status."
        : "Check esa API response details and request parameters.";
  }
}

function cleanPayload(payload: ToolErrorPayload): ToolErrorPayload {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)) as ToolErrorPayload;
}

function sanitizeDetails(details: Record<string, unknown> | undefined) {
  if (!details) {
    return undefined;
  }
  return sanitizeValue(details) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redact(value).slice(0, 1000);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return depth >= 3 ? "[array]" : value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 3) {
      return "[object]";
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveDetailKey(key))
      .slice(0, 30)
      .map(([key, item]) => [key, sanitizeValue(item, depth + 1)]);
    return Object.fromEntries(entries);
  }
  return String(value);
}

const SENSITIVE_KEY_FRAGMENTS = Object.values(SensitiveKeyFragment);

function isSensitiveDetailKey(key: string) {
  const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
}

function stringifyBody(body: unknown) {
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body ?? "");
  } catch {
    return "";
  }
}

function redact(value: string) {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}
