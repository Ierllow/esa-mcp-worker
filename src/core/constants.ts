export const ESA_API_BASE_URL = "https://api.esa.io/v1";
export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";

export enum HttpStatusCode {
  Created = 201,
  SeeOther = 303,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  MethodNotAllowed = 405,
  Conflict = 409,
  UnprocessableEntity = 422,
  TooManyRequests = 429,
  InternalServerError = 500,
  ServiceUnavailable = 503,
}

export enum HttpMethod {
  Get = "GET",
  Post = "POST",
  Patch = "PATCH",
  Delete = "DELETE",
}

export enum EsaRequestAccess {
  Read = "read",
  Write = "write",
}

export enum EsaCacheMode {
  Default = "default",
  NoStore = "no-store",
}

export enum SensitiveKeyFragment {
  Token = "token",
  Secret = "secret",
  Password = "password",
  Authorization = "authorization",
  ApiKey = "apikey",
}

export enum GithubCredentialMode {
  App = "app",
  None = "none",
}

export enum GithubTreeEntryType {
  Blob = "blob",
  Tree = "tree",
  Commit = "commit",
}

export enum GithubContentType {
  File = "file",
}

export enum GithubContentEncoding {
  Base64 = "base64",
}

export enum GithubCheckRunStatus {
  Completed = "completed",
}

export enum GithubCheckRunConclusion {
  Success = "success",
  Neutral = "neutral",
  Skipped = "skipped",
}

export enum GithubCommitState {
  Error = "error",
  Failure = "failure",
  Pending = "pending",
  Success = "success",
}
export const DEFAULT_OAUTH_REDIRECT_HOSTS = ["chatgpt.com", "claude.ai"] as const;
export enum OAuthScope {
  Read = "esa:read",
  Write = "esa:write",
}
export const OAUTH_SCOPES = Object.values(OAuthScope);
export const OAUTH_SCOPE = OAUTH_SCOPES.join(" ");

export enum OAuthResponseType {
  Code = "code",
}

export enum OAuthGrantType {
  AuthorizationCode = "authorization_code",
}

export enum PkceCodeChallengeMethod {
  S256 = "S256",
}

export enum OAuthClientAuthMethod {
  None = "none",
}

export enum OAuthErrorCode {
  InvalidToken = "invalid_token",
  InvalidRequest = "invalid_request",
  InvalidRedirectUri = "invalid_redirect_uri",
  InvalidScope = "invalid_scope",
  InvalidGrant = "invalid_grant",
  InsufficientScope = "insufficient_scope",
  MethodNotAllowed = "method_not_allowed",
  InvalidTarget = "invalid_target",
  ServerError = "server_error",
}

export enum OAuthTokenType {
  Bearer = "Bearer",
}

export enum SignedPayloadKind {
  AuthorizationCode = "code",
  AccessToken = "access",
  RememberedAuth = "remembered_auth",
  AdminSession = "admin",
}

export const AUTH_CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REMEMBERED_AUTH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const KV_OAUTH_PASSCODE_KEY = "oauth_passcode";
export const KV_SIGNING_SECRET_KEY = "signing_secret";
export const AUDIT_PREFIX = "audit:";
export const CONNECTION_PREFIX = "connection:";
export const CONTEXT_OBSERVER_PREFIX = "context_observer:";

export enum AuditLevel {
  Minimal = "minimal",
  All = "all",
  None = "none",
}

export enum AuditEventType {
  ToolCall = "tool_call",
  OauthAuthorizeFailed = "oauth_authorize_failed",
  EsaTokenValidationFailed = "esa_token_validation_failed",
  OauthConnected = "oauth_connected",
  AdminLoginFailed = "admin_login_failed",
  AdminLogin = "admin_login",
  AdminRotatedPasscode = "admin_rotated_passcode",
  AdminRevokedSessions = "admin_revoked_sessions",
}

export enum AuditStatus {
  Success = "success",
  Failed = "failed",
}


export enum ReadResultStatus {
  Success = "success",
  Failed = "failed",
}

export enum BatchItemStatus {
  Ok = "ok",
  Error = "error",
  Skipped = "skipped",
}

export enum ContextChangeStatus {
  Changed = "changed",
  Unchanged = "unchanged",
}

export enum OperationStatus {
  Completed = "completed",
  Partial = "partial",
}

export enum ActivePageRole {
  Entry = "entry",
  OperationsEntry = "operations_entry",
  Guide = "guide",
  Policy = "policy",
  ReadPolicy = "read_policy",
  ResponsePolicy = "response_policy",
  WritePolicy = "write_policy",
  SaveOperation = "save_operation",
  BulkUpdateGuard = "bulk_update_guard",
  Freshness = "freshness",
  RevisionGate = "revision_gate",
  CurrentState = "current_state",
  StructureAudit = "structure_audit",
  McpRuntime = "mcp_runtime",
  ImplementationSync = "implementation_sync",
  Registry = "registry",
}

export enum RepositoryChangeOperation {
  Upsert = "upsert",
  Delete = "delete",
}

export enum ImplementationImpactDecision {
  Changed = "changed",
  NotAffected = "not_affected",
}

export enum ImplementationReviewArea {
  RuntimeBehavior = "runtime_behavior",
  ToolContract = "tool_contract",
  Configuration = "configuration",
  AuthSecurity = "auth_security",
  ErrorsAudit = "errors_audit",
  Performance = "performance",
  Tests = "tests",
  Documentation = "documentation",
}

export enum RepositoryValidationStatus {
  Ready = "ready",
  Pending = "pending",
  Failed = "failed",
  Missing = "missing",
}

export enum ActivePageAutoRead {
  Always = "always",
  FirstContextAnswer = "first_context_answer",
  OnDemand = "on_demand",
  Conditional = "conditional",
}

export enum ActivePageFreshness {
  ContextVersion = "context_version",
  Revision = "revision",
  KvObserver = "kv_observer",
  Self = "self",
}

export enum RegistryLintStatus {
  Valid = "valid",
  Issues = "issues",
}

export enum RegistryIssueSeverity {
  Error = "error",
  Warning = "warning",
}

export enum RegistryIssueCode {
  DuplicatePost = "duplicate_post",
  DuplicateRole = "duplicate_role",
  EntryCount = "entry_count",
  EntryAutoRead = "entry_auto_read",
  DuplicateRoute = "duplicate_route",
  UnexpectedSelfFreshness = "unexpected_self_freshness",
  MissingPost = "missing_post",
  ArchivedPost = "archived_post",
  MissingTarget = "missing_target",
  ArchivedTarget = "archived_target",
  StaleSuccessorRoute = "stale_successor_route",
  UnreachablePage = "unreachable_page",
  ObserverMissing = "observer_missing",
}

export enum ModelReadMode {
  Metadata = "metadata",
  Outline = "outline",
  Excerpt = "excerpt",
  Markdown = "markdown",
}

export type ContextPrefetchMode = Exclude<ModelReadMode, ModelReadMode.Metadata>;

export enum EsaSearchSort {
  Updated = "updated",
  Created = "created",
  Number = "number",
  Stars = "stars",
  Watches = "watches",
  Comments = "comments",
  BestMatch = "best_match",
}

export enum EsaSearchOrder {
  Desc = "desc",
  Asc = "asc",
}

export enum EsaPostInclude {
  Comments = "comments",
  Stargazers = "stargazers",
  CommentsAndStargazers = "comments,stargazers",
  Backlinks = "backlinks",
}

export enum PostPatchType {
  ReplaceSection = "replace_section",
  ReplaceText = "replace_text",
}


export enum McpProfile {
  Full = "full",
  Fast = "fast",
}

export const MCP_PROFILE_REQUIRED_SCOPES: Record<McpProfile, readonly OAuthScope[]> = {
  [McpProfile.Full]: [OAuthScope.Read, OAuthScope.Write],
  [McpProfile.Fast]: [OAuthScope.Read],
};

export const MCP_PROFILE_PATHS: Record<McpProfile, string> = {
  [McpProfile.Full]: "/mcp",
  [McpProfile.Fast]: "/mcp-fast",
};

export const MCP_PROFILE_BY_PATH: Record<string, McpProfile> = Object.fromEntries(
  Object.entries(MCP_PROFILE_PATHS).map(([profile, path]) => [path, profile as McpProfile]),
);

export const MCP_ENDPOINT_PATHS = Object.values(MCP_PROFILE_PATHS);

export const E2E_PREVIEW_CLIENT_ID = "esa-mcp-e2e-preview";
export const E2E_PREVIEW_UPSTREAM_SENTINEL = "preview-e2e-no-upstream-access";

export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const RUNTIME_VERSION_HEADER = "X-MCP-Runtime-Version";

export enum ContextObserverSchema {
  ObserverV1 = "esa_mcp.context_observer.v1",
  UpdateCheckV1 = "esa_mcp.context_update_check.v1",
  KvV1 = "esa_mcp.context_observer.kv.v1",
}

export enum ObserverReadMode {
  Compact = "compact",
  Outline = "outline",
  Sections = "sections",
  Full = "full",
}
