import type { DomainStatus, ErrorSource } from "./errors";
import {
  SignedPayloadKind,
  type EsaCacheMode,
  type EsaRequestAccess,
  type HttpMethod,
  type AuditEventType,
  type AuditLevel,
  type AuditStatus,
} from "./constants";

export type Env = {
  ESA_DEFAULT_TEAM?: string;
  ESA_CONTEXT_ENTRY_POST_NUMBER?: string;
  ESA_CONTEXT_SUMMARY_POST_NUMBER?: string;
  ESA_CONTEXT_OBSERVER_POST_NUMBER?: string;
  ESA_ACTIVE_PAGE_REGISTRY_POST_NUMBER?: string;
  ESA_VALIDATION_POST_NUMBER?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_DEFAULT_BRANCH?: string;
  GITHUB_BRANCH_PREFIX?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  MCP_BEARER_TOKEN?: string;
  MCP_OAUTH_PASSCODE?: string;
  MCP_OAUTH_ALLOWED_REDIRECT_HOSTS?: string;
  MCP_ADMIN_USERNAME?: string;
  MCP_ADMIN_PASSWORD?: string;
  MCP_AUDIT_LEVEL?: AuditLevel;
  MCP_SLOW_TOOL_THRESHOLD_MS?: string;
  MCP_CONNECTION_WRITE_INTERVAL_SECONDS?: string;
  MCP_E2E_PREVIEW_BEARER_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  MCP_CONFIG?: KVNamespace;
  OAUTH_CODE_DB?: D1Database;
  GITHUB_REQUIRED_CHECK_NAMES?: string;
};

export type EsaRateLimitInfo = {
  limit?: number;
  remaining?: number;
  reset_at?: string;
};

export type EsaRequestOptions = {
  teamName: string;
  path: string;
  token: string;
  method?: HttpMethod;
  access: EsaRequestAccess;
  searchParams?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  cache?: EsaCacheMode;
  onRateLimit?: (info: EsaRateLimitInfo) => void;
};

export type AuthCodePayload = {
  kind: SignedPayloadKind.AuthorizationCode;
  code_id: string;
  exp: number;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  encrypted_esa_token: string;
  connection_id: string;
  esa_user_id?: number;
  esa_token_scope?: string[];
};

export type AccessTokenPayload = {
  kind: SignedPayloadKind.AccessToken;
  exp: number;
  aud: string;
  scope: string;
  client_id?: string;
  encrypted_esa_token: string;
  connection_id: string;
  esa_user_id?: number;
  esa_token_scope?: string[];
};

export type RememberedAuthPayload = {
  kind: SignedPayloadKind.RememberedAuth;
  exp: number;
  redirect_host: string;
  passcode_hash: string;
  encrypted_esa_token: string;
};

export type AdminSessionPayload = {
  kind: SignedPayloadKind.AdminSession;
  exp: number;
};

export type AuditEvent = {
  id: string;
  ts: string;
  type: AuditEventType;
  client_id?: string;
  connection_id?: string;
  tool_name?: string;
  status?: AuditStatus;
  error_source?: ErrorSource;
  domain_status?: DomainStatus;
  error_message?: string;
  http_status?: number;
  duration_ms?: number;
  target?: string;
  redirect_host?: string;
  scope?: string;
  actor?: string;
  esa_user_id?: number;
  esa_token_scope?: string;
  ip_hash?: string;
  user_agent?: string;
};

export type EsaTokenInfo = {
  id?: number;
  resource_owner_id?: number;
  scope?: string[] | string;
  user?: {
    id?: number;
  };
};

export type McpAuthSuccess = {
  esaToken: string;
  payload: AccessTokenPayload;
};

export type ConnectionRecord = {
  id: string;
  connected_at: string;
  expires_at: string;
  last_seen_at?: string;
  client_id: string;
  redirect_host?: string;
  scope: string;
  esa_user_id?: number;
  esa_token_scope?: string;
  github_connected: boolean;
  ip_hash?: string;
  user_agent?: string;
  tool_counts?: Record<string, number>;
};
