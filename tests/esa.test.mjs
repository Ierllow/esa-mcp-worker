import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import test from "node:test";
import {
  batchMoveCategory,
  BULK_CREATE_POSTS_MAX_COUNT,
  BULK_UPDATE_POSTS_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
  bulkCreatePosts,
  bulkUpdatePosts,
  checkContextDrift,
  esaGet,
  getPostCollection,
  getPostsModelView,
  loadContextEntry,
  readPostSections,
  refreshContextObserver,
  resolveContextEntryPostNumber,
  resolveContextSummaryPostNumber,
  resolveTeamName,
  runEsaCommand,
  searchPostsMulti,
  updatePost,
} from "../src/esa/esa.ts";
import { createServer } from "../src/mcp/mcp.ts";
import worker from "../src/index.ts";
import { shouldWriteAudit, updateConnectionUsage } from "../src/core/audit.ts";
import { clearConfigCache } from "../src/core/config.ts";
import { createSignedValue, verifySignedValue } from "../src/core/crypto.ts";
import { DomainStatus, ErrorSource, ToolError, esaApiError, normalizeToolError } from "../src/core/errors.ts";
import {
  authenticateMcpRequest,
  canonicalResource,
  oauthAuthorizationServerMetadata,
  oauthAuthorize,
  oauthRegister,
  oauthToken,
  previewAuthentication,
  protectedResourceMetadata,
  sha256Base64Url,
} from "../src/auth/oauth.ts";
import {
  createImplementationBranch,
  clearGithubAppTokenCache,
  getImplementationStatus,
  getRepositorySnapshot,
  publishImplementation,
  readRepositoryFiles,
  resolveGithubAccessToken,
  resolveGithubConfig,
} from "../src/github/github.ts";
import {
  EsaRequestAccess,
  HttpMethod,
  HttpStatusCode,
  ImplementationImpactDecision,
  ImplementationReviewArea,
  MCP_PROFILE_REQUIRED_SCOPES,
  McpProfile,
  OAuthErrorCode,
  OAuthGrantType,
  OAuthScope,
  OAUTH_SCOPE as OAUTH_SCOPE_ALL,
  RepositoryChangeOperation,
  SignedPayloadKind,
} from "../src/core/constants.ts";
import { attachToolTiming, createContextResult, createTextResult, createWriteResult } from "../src/core/utils.ts";
import { readContextObserverManifest, syncObservedPostBaselines } from "../src/state/context-observer.ts";
import { renderAdminDashboard, renderAdminLogin } from "../src/admin/admin.ts";
import {
  lintActivePageRegistry,
  parseActivePageRegistry,
  resolveActivePageRegistryPostNumber,
} from "../src/state/active-page-registry.ts";

globalThis.crypto ??= webcrypto;

test("admin pages render the responsive operations shell", async () => {
  const loginHtml = await renderAdminLogin("Login failed").text();
  const dashboardHtml = await (await renderAdminDashboard({
    MCP_BEARER_TOKEN: "test-signing-secret",
    MCP_ADMIN_PASSWORD: "test-admin-password",
  }, undefined, "test-passcode")).text();

  assert.match(loginHtml, /class="login-panel"/);
  assert.match(loginHtml, /class="brand-mark"/);
  assert.match(dashboardHtml, /class="summary-strip"/);
  assert.match(dashboardHtml, /class="section-tabs" role="tablist"/);
  assert.match(dashboardHtml, /class="tab-panel" role="tabpanel"/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\("esa-mcp-admin-tab"/);
  assert.match(dashboardHtml, /class="table-wrap"/);
  assert.match(dashboardHtml, /id="copy-passcode"/);
  assert.match(dashboardHtml, /colspan="8"/);
});

test("esa API statuses map to stable domain statuses", () => {
  const cases = [
    { status: HttpStatusCode.Unauthorized, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/posts/1", body: { message: "token expired" }, expected: DomainStatus.EsaTokenExpired },
    { status: HttpStatusCode.Unauthorized, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/posts/1", body: {}, expected: DomainStatus.EsaAuthFailed },
    { status: HttpStatusCode.Forbidden, method: HttpMethod.Patch, access: EsaRequestAccess.Read, path: "/posts/1", body: {}, expected: DomainStatus.EsaPermissionDenied },
    { status: HttpStatusCode.Forbidden, method: HttpMethod.Get, access: EsaRequestAccess.Write, path: "/posts/1", body: {}, expected: DomainStatus.EsaWritePermissionRequired },
    { status: HttpStatusCode.NotFound, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/posts/1", body: {}, expected: DomainStatus.EsaPostNotFound },
    { status: HttpStatusCode.NotFound, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/posts", body: {}, expected: DomainStatus.EsaResourceNotFound },
    { status: HttpStatusCode.NotFound, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/teams/example", body: {}, expected: DomainStatus.EsaTeamOrEndpointNotFound },
    { status: HttpStatusCode.Conflict, method: HttpMethod.Patch, access: EsaRequestAccess.Write, path: "/posts/1", body: {}, expected: DomainStatus.EsaRevisionConflict },
    { status: HttpStatusCode.UnprocessableEntity, method: HttpMethod.Post, access: EsaRequestAccess.Write, path: "/posts", body: {}, expected: DomainStatus.EsaValidationFailed },
    { status: HttpStatusCode.TooManyRequests, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/posts", body: {}, expected: DomainStatus.EsaRateLimited },
    { status: HttpStatusCode.ServiceUnavailable, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/posts", body: {}, expected: DomainStatus.EsaUnavailable },
    { status: HttpStatusCode.BadRequest, method: HttpMethod.Get, access: EsaRequestAccess.Read, path: "/posts", body: {}, expected: DomainStatus.EsaRequestFailed },
  ];

  for (const item of cases) {
    const error = esaApiError({
      status: item.status,
      statusText: "Test error",
      method: item.method,
      access: item.access,
      path: item.path,
      body: item.body,
    });
    const payload = normalizeToolError(error);
    assert.equal(payload.domain_status, item.expected);
    assert.equal("code" in payload, false);
  }
});

test("sensitive detail keys are removed without exposing their values", () => {
  const error = normalizeToolError(new ToolError({
    source: ErrorSource.Input,
    domainStatus: DomainStatus.InvalidInput,
    message: "Invalid input.",
    details: {
      access_token: "access-value",
      apiKey: "api-key-value",
      nested: { user_password: "password-value", visible: "kept" },
      visible: "kept",
    },
  }));

  assert.deepEqual(error.details, {
    nested: { visible: "kept" },
    visible: "kept",
  });
});

test("untyped errors preserve inference priority", () => {
  const cases = [
    {
      message: "Workers KV put operation failed: 429 quota exceeded",
      source: ErrorSource.Cloudflare,
      domainStatus: DomainStatus.CloudflareKvWriteBlocked,
      httpStatus: HttpStatusCode.ServiceUnavailable,
    },
    {
      message: "confirm_write is required",
      source: ErrorSource.WriteConfirmation,
      domainStatus: DomainStatus.WriteConfirmationRequired,
    },
    {
      message: "team_name is required",
      source: ErrorSource.Input,
      domainStatus: DomainStatus.TeamRequired,
    },
    {
      message: "MCP_CONFIG is not configured",
      source: ErrorSource.ServerConfig,
      domainStatus: DomainStatus.ServerConfigMissing,
      httpStatus: HttpStatusCode.InternalServerError,
    },
  ];

  for (const item of cases) {
    const error = normalizeToolError(new Error(item.message));
    assert.equal(error.source, item.source);
    assert.equal(error.domain_status, item.domainStatus);
    assert.equal(error.http_status, item.httpStatus);
  }
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function memoryKv(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key, format) {
      const value = values.get(key);
      if (value === undefined) {
        return null;
      }
      return format === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

function oauthParameters(overrides = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: "test-mcp-client",
    redirect_uri: "https://chatgpt.com/connector/oauth/test/callback",
    state: "state",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    resource: "https://mcp.example.com",
    scope: "esa:read esa:write",
    ...overrides,
  });
}

function oauthEnvironment(overrides = {}) {
  return {
    MCP_BEARER_TOKEN: "test-signing-secret",
    MCP_OAUTH_PASSCODE: "test-passcode",
    MCP_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com",
    ESA_DEFAULT_TEAM: "example-team",
    ESA_VALIDATION_POST_NUMBER: "6",
    OAUTH_CODE_DB: memoryD1Database(),
    ...overrides,
  };
}

function memoryD1Database() {
  const consumedCodes = new Set();
  return {
    prepare(query) {
      return {
        bind(...values) {
          return { query, values };
        },
      };
    },
    async batch(statements) {
      const codeId = statements[1].values[0];
      if (consumedCodes.has(codeId)) {
        return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
      }
      consumedCodes.add(codeId);
      return [{ meta: { changes: 0 } }, { meta: { changes: 1 } }];
    },
  };
}

function oauthRequest(method, params, cookie) {
  const url = new URL("https://mcp.example.com/oauth/authorize");
  const init = { method, headers: {} };
  if (cookie) {
    init.headers.Cookie = cookie;
  }
  if (method === HttpMethod.Post) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = params.toString();
  } else {
    url.search = params.toString();
  }
  return new Request(url, init);
}

function githubEnvironment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "example-owner/example-repository",
    GITHUB_DEFAULT_BRANCH: "trunk",
    GITHUB_BRANCH_PREFIX: "mcp-change/",
    GITHUB_REQUIRED_CHECK_NAMES: "Cloudflare Workers",
    ...overrides,
  };
}

function oauthTokenRequest(params) {
  return new Request("https://mcp.example.com/oauth/token", {
    method: HttpMethod.Post,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

function implementationReview() {
  return Object.fromEntries(Object.values(ImplementationReviewArea).map((area) => [
    area,
    { decision: ImplementationImpactDecision.NotAffected, note: `${area} checked` },
  ]));
}

test("signed values with invalid JSON fail closed", async () => {
  const secret = "test-signing-secret";
  const encodedPayload = Buffer.from("not-json").toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload)),
  ).toString("base64url");

  assert.equal(await verifySignedValue(`${encodedPayload}.${signature}`, secret), undefined);
});

test("write result tells the client when no follow-up is needed", () => {
  const result = createWriteResult("post_updated", { number: 6, revision_number: 8 });

  assert.equal(result.structuredContent.operation_status, "completed");
  assert.equal(result.structuredContent.needs_follow_up, false);
  assert.equal(result.content[0].text, "処理は完了しました。追加確認は不要です。");
  assert.doesNotMatch(result.content[0].text, /revision_number/);
});

test("partial write result requests focused follow-up", () => {
  const result = createWriteResult("posts_updated", { failed: 1, skipped: 0 }, "partial");

  assert.equal(result.structuredContent.operation_status, "partial");
  assert.equal(result.structuredContent.needs_follow_up, true);
});

test("tool timing is added without duplicating content", () => {
  const result = attachToolTiming(createWriteResult("post_updated", { number: 6 }), 1234);

  assert.equal(result.structuredContent.elapsed_ms, 1234);
  assert.equal(result.structuredContent.elapsed_seconds, 1.234);
  assert.doesNotMatch(result.content[0].text, /1\.234/);
});

test("structured results are not serialized into text content", () => {
  const smallResult = createTextResult({ number: 123, title: "example.md" });
  const result = createTextResult({ body_md: "x".repeat(2_000) });

  assert.equal(smallResult.content[0].text, "取得しました。");
  assert.doesNotMatch(smallResult.content[0].text, /example\.md/);
  assert.equal(result.structuredContent.body_md.length, 2_000);
  assert.doesNotMatch(result.content[0].text, /x{100}/);
});

test("minimal audit keeps failures and slow tools", () => {
  const env = {
    MCP_AUDIT_LEVEL: "minimal",
    MCP_SLOW_TOOL_THRESHOLD_MS: "1000",
  };

  assert.equal(shouldWriteAudit(env, "tool_call", { status: "success", duration_ms: 999 }), false);
  assert.equal(shouldWriteAudit(env, "tool_call", { status: "success", duration_ms: 1_000 }), true);
  assert.equal(shouldWriteAudit(env, "tool_call", { status: "failed", duration_ms: 1 }), true);
});

test("connection usage avoids repeated KV reads inside the write interval", async () => {
  let reads = 0;
  let writes = 0;
  const env = {
    MCP_CONNECTION_WRITE_INTERVAL_SECONDS: "900",
    MCP_CONFIG: {
      async get() {
        reads += 1;
        return {
          id: "cached-connection",
          connected_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          last_seen_at: new Date().toISOString(),
          client_id: "test-client",
          scope: "esa:read",
        };
      },
      async put() {
        writes += 1;
      },
    },
  };

  await updateConnectionUsage(env, "cached-connection", "esa_get_post");
  await updateConnectionUsage(env, "cached-connection", "esa_get_post");

  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test("remembered OAuth authorization avoids credential re-entry without exposing plaintext", async () => {
  clearConfigCache();
  const env = oauthEnvironment();
  const firstParams = oauthParameters({
    passcode: "test-passcode",
    esa_access_token: "secret-esa-token",
    vendor_api_key: "secret-vendor-key",
    remember_browser: "1",
  });
  const authorizationHeaders = [];

  await withFetch(async (_input, init) => {
    authorizationHeaders.push(init?.headers?.Authorization);
    return jsonResponse({ number: 6, revision_number: 1 });
  }, async () => {
    const firstResponse = await oauthAuthorize(oauthRequest("POST", firstParams), env);
    const setCookie = firstResponse.headers.get("Set-Cookie");
    const cookie = setCookie.split(";", 1)[0];

    assert.equal(firstResponse.status, 302);
    assert.equal(firstResponse.headers.get("Cache-Control"), "no-store");
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax; Path=\/oauth; Max-Age=2592000/);
    assert.doesNotMatch(setCookie, /secret-esa-token|secret-vendor-key|test-passcode/);

    const getResponse = await oauthAuthorize(oauthRequest("GET", oauthParameters(), cookie), env);
    const getHtml = await getResponse.text();
    assert.match(getHtml, /保存済み認証情報でAuthorize/);
    assert.doesNotMatch(getHtml, /name="esa_access_token"/);
    assert.doesNotMatch(getHtml, /secret-vendor-key/);

    const rememberedParams = oauthParameters({ use_remembered: "1" });
    const rememberedResponse = await oauthAuthorize(oauthRequest("POST", rememberedParams, cookie), env);
    assert.equal(rememberedResponse.status, 302);
    assert.equal(authorizationHeaders.at(-1), "Bearer secret-esa-token");
  });
});

test("OAuth uses server-side GitHub App configuration without client-held GitHub credentials", async () => {
  clearConfigCache();
  const env = oauthEnvironment({
    GITHUB_REPOSITORY: "example-owner/example-repository",
    GITHUB_DEFAULT_BRANCH: "trunk",
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY: "configured-as-a-worker-secret",
  });
  const params = oauthParameters({
    passcode: "test-passcode",
    esa_access_token: "secret-esa-token",
    remember_browser: "1",
  });

  await withFetch(async (input) => {
    return jsonResponse({ number: 6, revision_number: 1 });
  }, async () => {
    const form = await oauthAuthorize(oauthRequest("GET", oauthParameters()), env);
    const html = await form.text();
    const response = await oauthAuthorize(oauthRequest("POST", params), env);
    const location = new URL(response.headers.get("Location"));
    const code = location.searchParams.get("code");
    const payload = await verifySignedValue(code, env.MCP_BEARER_TOKEN);
    const cookie = response.headers.get("Set-Cookie");

    assert.doesNotMatch(html, /name="github_token"/);
    assert.match(html, /GitHub App/);
    assert.equal(response.status, 302);
    assert.equal(payload.encrypted_github_token, undefined);
    assert.doesNotMatch(cookie, /github_pat_|ghp_/);
  });
});

test("GitHub App mints and caches a repository installation token from a PKCS1 key", async () => {
  clearGithubAppTokenCache();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env = githubEnvironment({
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  });
  let requests = 0;

  await withFetch(async (input, init = {}) => {
    requests += 1;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/app/installations/456/access_tokens");
    assert.equal(init.method, "POST");
    assert.match(init.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    return jsonResponse({
      token: "installation-token",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  }, async () => {
    assert.equal(await resolveGithubAccessToken(env), "installation-token");
    assert.equal(await resolveGithubAccessToken(env), "installation-token");
  });

  assert.equal(requests, 1);
});

test("rotating the OAuth passcode invalidates remembered browser authorization", async () => {
  clearConfigCache();
  const env = oauthEnvironment();
  let cookie;
  await withFetch(async () => jsonResponse({ number: 6 }), async () => {
    const response = await oauthAuthorize(
      oauthRequest("POST", oauthParameters({
        passcode: "test-passcode",
        esa_access_token: "secret-esa-token",
        remember_browser: "1",
      })),
      env,
    );
    cookie = response.headers.get("Set-Cookie").split(";", 1)[0];
  });

  clearConfigCache();
  const response = await oauthAuthorize(
    oauthRequest("GET", oauthParameters(), cookie),
    oauthEnvironment({ MCP_OAUTH_PASSCODE: "rotated-passcode" }),
  );
  const html = await response.text();

  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.match(html, /name="esa_access_token"/);
  assert.doesNotMatch(html, /保存済み認証情報でAuthorize/);
});

test("expired remembered browser authorization is cleared", async () => {
  clearConfigCache();
  const env = oauthEnvironment();
  const value = await createSignedValue(
    {
      kind: "remembered_auth",
      exp: 0,
      redirect_host: "chatgpt.com",
      passcode_hash: "expired",
      encrypted_esa_token: "expired",
    },
    env.MCP_BEARER_TOKEN,
  );
  const response = await oauthAuthorize(
    oauthRequest("GET", oauthParameters(), `esa_mcp_remembered_auth=${value}`),
    env,
  );
  const html = await response.text();

  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.match(html, /name="esa_access_token"/);
  assert.doesNotMatch(html, /保存済み認証情報でAuthorize/);
});

test("OAuth registration rejects redirect hosts outside the allowlist", async () => {
  const env = oauthEnvironment();
  const rejected = await oauthRegister(
    new Request("https://mcp.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://example.net/callback"] }),
    }),
    env,
  );
  const accepted = await oauthRegister(
    new Request("https://mcp.example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/connector/oauth/test/callback"] }),
    }),
    env,
  );

  assert.equal(rejected.status, 400);
  assert.equal(accepted.status, 201);
});

test("OAuth registration accepts ChatGPT and Claude callback hosts by default", async () => {
  const env = oauthEnvironment({ MCP_OAUTH_ALLOWED_REDIRECT_HOSTS: undefined });
  const callbackUrls = [
    "https://chatgpt.com/connector/oauth/test/callback",
    "https://claude.ai/api/mcp/auth_callback",
  ];

  for (const redirectUri of callbackUrls) {
    const response = await oauthRegister(
      new Request("https://mcp.example.com/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
      env,
    );
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.match(body.client_id, /^mcp-client-/);
  }
});

test("OAuth metadata advertises implemented registration capabilities only", async () => {
  const response = oauthAuthorizationServerMetadata(new Request("https://mcp.example.com/.well-known/oauth-authorization-server"));
  const metadata = await response.json();

  assert.equal(metadata.registration_endpoint, "https://mcp.example.com/oauth/register");
  assert.equal(Object.hasOwn(metadata, "client_id_metadata_document_supported"), false);
});

test("OAuth codes are single-use and endpoint scopes are enforced", async () => {
  clearConfigCache();
  const env = oauthEnvironment();
  const verifier = "test-code-verifier-with-sufficient-length";
  const challenge = await sha256Base64Url(verifier);
  const authorizeParams = oauthParameters({
    passcode: "test-passcode",
    esa_access_token: "secret-esa-token",
    code_challenge: challenge,
    scope: OAuthScope.Read,
  });
  const authorization = await withFetch(
    async () => jsonResponse({ number: 6, revision_number: 1 }),
    () => oauthAuthorize(oauthRequest(HttpMethod.Post, authorizeParams), env),
  );
  const code = new URL(authorization.headers.get("Location")).searchParams.get("code");
  const tokenParams = new URLSearchParams({
    grant_type: OAuthGrantType.AuthorizationCode,
    code,
    redirect_uri: authorizeParams.get("redirect_uri"),
    client_id: authorizeParams.get("client_id"),
    code_verifier: verifier,
    resource: authorizeParams.get("resource"),
  });

  const firstExchange = await oauthToken(oauthTokenRequest(tokenParams), env);
  const firstBody = await firstExchange.json();
  const replayExchange = await oauthToken(oauthTokenRequest(tokenParams), env);
  const replayBody = await replayExchange.json();

  assert.equal(firstExchange.status, 200);
  assert.equal(firstBody.scope, OAuthScope.Read);
  assert.equal(replayExchange.status, HttpStatusCode.BadRequest);
  assert.equal(replayBody.error, OAuthErrorCode.InvalidGrant);

  const fastAuth = await authenticateMcpRequest(
    new Request("https://mcp.example.com/mcp-fast", { headers: { Authorization: `Bearer ${firstBody.access_token}` } }),
    env,
    MCP_PROFILE_REQUIRED_SCOPES[McpProfile.Fast],
  );
  assert.equal(fastAuth instanceof Response, false);

  const fullAuth = await authenticateMcpRequest(
    new Request("https://mcp.example.com/mcp", { headers: { Authorization: `Bearer ${firstBody.access_token}` } }),
    env,
    MCP_PROFILE_REQUIRED_SCOPES[McpProfile.Full],
  );
  assert.equal(fullAuth.status, HttpStatusCode.Forbidden);
  assert.equal((await fullAuth.json()).error, OAuthErrorCode.InsufficientScope);
  assert.match(fullAuth.headers.get("WWW-Authenticate"), /error="insufficient_scope"/);
  assert.match(fullAuth.headers.get("WWW-Authenticate"), /scope="esa:read esa:write"/);

  const missingAuth = await authenticateMcpRequest(
    new Request("https://mcp.example.com/mcp-fast"),
    env,
    MCP_PROFILE_REQUIRED_SCOPES[McpProfile.Fast],
  );
  assert.equal(missingAuth.status, HttpStatusCode.Unauthorized);
  assert.match(missingAuth.headers.get("WWW-Authenticate"), /scope="esa:read"/);
  assert.doesNotMatch(missingAuth.headers.get("WWW-Authenticate"), /esa:write/);

  const invalidAuth = await authenticateMcpRequest(
    new Request("https://mcp.example.com/mcp-fast", { headers: { Authorization: "Bearer invalid-token" } }),
    env,
    MCP_PROFILE_REQUIRED_SCOPES[McpProfile.Fast],
  );
  assert.equal(invalidAuth.status, HttpStatusCode.Unauthorized);
  assert.equal((await invalidAuth.json()).error, OAuthErrorCode.InvalidToken);

  const expiredToken = await createSignedValue({
    kind: SignedPayloadKind.AccessToken,
    exp: 0,
    aud: "https://mcp.example.com",
    scope: OAuthScope.Read,
    encrypted_esa_token: "unused",
    connection_id: "expired-connection",
  }, env.MCP_BEARER_TOKEN);
  const expiredAuth = await authenticateMcpRequest(
    new Request("https://mcp.example.com/mcp-fast", { headers: { Authorization: `Bearer ${expiredToken}` } }),
    env,
    MCP_PROFILE_REQUIRED_SCOPES[McpProfile.Fast],
  );
  assert.equal(expiredAuth.status, HttpStatusCode.Unauthorized);
  assert.equal((await expiredAuth.json()).error, OAuthErrorCode.InvalidToken);
});

test("GitHub configuration is deployment-specific", () => {
  assert.deepEqual(resolveGithubConfig(githubEnvironment()), {
    owner: "example-owner",
    repo: "example-repository",
    fullName: "example-owner/example-repository",
    defaultBranch: "trunk",
    branchPrefix: "mcp-change/",
    requiredCheckNames: ["Cloudflare Workers"],
  });
});

test("repository snapshot returns paths and concurrency SHAs without file bodies", async () => {
  const commitSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const fileSha = "c".repeat(40);
  const result = await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/commits/trunk")) {
      return jsonResponse({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    }
    if (url.pathname.endsWith(`/git/trees/${treeSha}`)) {
      return jsonResponse({
        sha: treeSha,
        truncated: false,
        tree: [{ path: "src/example.ts", mode: "100644", type: "blob", sha: fileSha, size: 12 }],
      });
    }
    return jsonResponse({ message: "not found" }, 404);
  }, () => getRepositorySnapshot({ env: githubEnvironment(), token: "github-token" }));

  assert.equal(result.base_sha, commitSha);
  assert.deepEqual(result.files, [{ path: "src/example.ts", sha: fileSha, size: 12, mode: "100644" }]);
  assert.equal("content" in result.files[0], false);
});

test("repository files are read in one bounded request group", async () => {
  const fileSha = "d".repeat(40);
  const result = await withFetch(async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("ref"), "trunk");
    return jsonResponse({
      type: "file",
      sha: fileSha,
      size: 17,
      encoding: "base64",
      content: Buffer.from("one\ntwo\nthree\n").toString("base64"),
    });
  }, () => readRepositoryFiles({
    env: githubEnvironment(),
    token: "github-token",
    files: [{ path: "src/example.ts", start_line: 2, end_line: 3 }],
  }));

  assert.equal(result.files[0].content, "two\nthree");
  assert.equal(result.files[0].sha, fileSha);
});

test("implementation branch uses the commit title as the entire message", async () => {
  const baseSha = "a".repeat(40);
  const baseTreeSha = "b".repeat(40);
  const fileSha = "c".repeat(40);
  const changedTreeSha = "d".repeat(40);
  const headSha = "e".repeat(40);
  const requests = [];
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith("/git/ref/heads/trunk")) {
      return jsonResponse({ object: { sha: baseSha } });
    }
    if (url.pathname.endsWith(`/git/commits/${baseSha}`)) {
      return jsonResponse({ sha: baseSha, tree: { sha: baseTreeSha } });
    }
    if (url.pathname.endsWith(`/git/trees/${baseTreeSha}`)) {
      return jsonResponse({
        truncated: false,
        tree: [{ path: "src/example.ts", mode: "100644", type: "blob", sha: fileSha, size: 10 }],
      });
    }
    if (url.pathname.endsWith("/git/trees") && init.method === "POST") {
      return jsonResponse({ sha: changedTreeSha }, 201);
    }
    if (url.pathname.endsWith("/git/commits") && init.method === "POST") {
      return jsonResponse({ sha: headSha, html_url: "https://github.example/commit" }, 201);
    }
    if (url.pathname.endsWith("/git/refs") && init.method === "POST") {
      return jsonResponse({ ref: body.ref, object: { sha: headSha } }, 201);
    }
    return jsonResponse({ message: "not found" }, 404);
  }, () => createImplementationBranch({
    env: githubEnvironment(),
    token: "github-token",
    expectedBaseSha: baseSha,
    branchSlug: "sync runtime",
    commitTitle: "Update runtime behavior",
    sourceEsaPosts: [123],
    review: implementationReview(),
    changes: [{
      operation: RepositoryChangeOperation.Upsert,
      path: "src/example.ts",
      expected_blob_sha: fileSha,
      content: "export const changed = true;\n",
    }],
  }));

  const commitRequest = requests.find((request) => request.path.endsWith("/git/commits") && request.method === "POST");
  assert.match(result.branch, /^mcp-change\/\d{8}t\d{6}z-[0-9a-f]{6}-sync-runtime$/);
  assert.equal(result.head_sha, headSha);
  assert.equal(requests.some((request) => request.path.includes("/pulls")), false);
  assert.equal(commitRequest.body.message, "Update runtime behavior");
});

test("implementation branch rejects a multiline commit title before network access", async () => {
  let requests = 0;
  await assert.rejects(withFetch(async () => {
    requests += 1;
    return jsonResponse({});
  }, () => createImplementationBranch({
    env: githubEnvironment(),
    token: "github-token",
    expectedBaseSha: "a".repeat(40),
    branchSlug: "invalid-title",
    commitTitle: "Update runtime\n\nGenerated details",
    sourceEsaPosts: [123],
    review: implementationReview(),
    changes: [{
      operation: RepositoryChangeOperation.Upsert,
      path: "src/example.ts",
      expected_blob_sha: "b".repeat(40),
      content: "changed\n",
    }],
  })), (error) => error.domainStatus === "invalid_input");
  assert.equal(requests, 0);
});

test("implementation correction replaces the commit on the same branch", async () => {
  const baseSha = "a".repeat(40);
  const baseTreeSha = "b".repeat(40);
  const fileSha = "c".repeat(40);
  const changedTreeSha = "d".repeat(40);
  const previousHeadSha = "e".repeat(40);
  const correctedHeadSha = "f".repeat(40);
  const branch = "mcp-change/20260906t120000z-example";
  const requests = [];
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith("/git/ref/heads/trunk")) {
      return jsonResponse({ object: { sha: baseSha } });
    }
    if (url.pathname.includes("/git/ref/heads/mcp-change/")) {
      return jsonResponse({ object: { sha: previousHeadSha } });
    }
    if (url.pathname.endsWith(`/git/commits/${baseSha}`)) {
      return jsonResponse({ sha: baseSha, tree: { sha: baseTreeSha } });
    }
    if (url.pathname.endsWith(`/git/trees/${baseTreeSha}`)) {
      return jsonResponse({
        truncated: false,
        tree: [{ path: "src/example.ts", mode: "100644", type: "blob", sha: fileSha, size: 10 }],
      });
    }
    if (url.pathname.endsWith("/git/trees") && init.method === "POST") {
      return jsonResponse({ sha: changedTreeSha }, 201);
    }
    if (url.pathname.endsWith("/git/commits") && init.method === "POST") {
      assert.deepEqual(body.parents, [baseSha]);
      return jsonResponse({ sha: correctedHeadSha, html_url: "https://github.example/corrected" }, 201);
    }
    if (url.pathname.includes("/git/refs/heads/mcp-change/") && init.method === "PATCH") {
      return jsonResponse({ object: { sha: correctedHeadSha } });
    }
    return jsonResponse({ message: "not found" }, 404);
  }, () => createImplementationBranch({
    env: githubEnvironment(),
    token: "github-token",
    expectedBaseSha: baseSha,
    branchSlug: "ignored-for-existing-branch",
    branch,
    expectedBranchHeadSha: previousHeadSha,
    commitTitle: "Correct runtime behavior",
    sourceEsaPosts: [123],
    review: implementationReview(),
    changes: [{
      operation: RepositoryChangeOperation.Upsert,
      path: "src/example.ts",
      expected_blob_sha: fileSha,
      content: "export const corrected = true;\n",
    }],
  }));

  const branchWrites = requests.filter((request) => request.path.includes("/git/refs"));
  assert.equal(result.branch, branch);
  assert.equal(result.branch_reused, true);
  assert.deepEqual(branchWrites, [{
    method: "PATCH",
    path: "/repos/example-owner/example-repository/git/refs/heads/mcp-change/20260906t120000z-example",
    body: { sha: correctedHeadSha, force: true },
  }]);
});

test("implementation branch rejects stale file SHAs before creating Git objects", async () => {
  const baseSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const currentFileSha = "c".repeat(40);
  let writes = 0;
  await assert.rejects(withFetch(async (input, init = {}) => {
    if (init.method && init.method !== "GET") {
      writes += 1;
    }
    const url = new URL(String(input));
    if (url.pathname.endsWith("/git/ref/heads/trunk")) {
      return jsonResponse({ object: { sha: baseSha } });
    }
    if (url.pathname.endsWith(`/git/commits/${baseSha}`)) {
      return jsonResponse({ sha: baseSha, tree: { sha: treeSha } });
    }
    return jsonResponse({
      truncated: false,
      tree: [{ path: "src/example.ts", mode: "100644", type: "blob", sha: currentFileSha }],
    });
  }, () => createImplementationBranch({
    env: githubEnvironment(),
    token: "github-token",
    expectedBaseSha: baseSha,
    branchSlug: "stale",
    commitTitle: "Reject stale change",
    sourceEsaPosts: [123],
    review: implementationReview(),
    changes: [{
      operation: RepositoryChangeOperation.Upsert,
      path: "src/example.ts",
      expected_blob_sha: "f".repeat(40),
      content: "changed\n",
    }],
  })), (error) => error.domainStatus === "github_file_conflict");
  assert.equal(writes, 0);
});

test("implementation branch blocks workflow and secret-file changes before network access", async () => {
  let requests = 0;
  await assert.rejects(withFetch(async () => {
    requests += 1;
    return jsonResponse({});
  }, () => createImplementationBranch({
    env: githubEnvironment(),
    token: "github-token",
    expectedBaseSha: "a".repeat(40),
    branchSlug: "unsafe",
    commitTitle: "Change workflow",
    sourceEsaPosts: [123],
    review: implementationReview(),
    changes: [{
      operation: RepositoryChangeOperation.Upsert,
      path: ".github/workflows/deploy.yml",
      expected_blob_sha: "b".repeat(40),
      content: "name: unsafe\n",
    }],
  })), (error) => error.domainStatus === "github_protected_path");
  assert.equal(requests, 0);
});

test("validated implementation publishes one commit and deletes the temporary branch", async () => {
  const baseSha = "a".repeat(40);
  const headSha = "e".repeat(40);
  const requests = [];
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith("/git/ref/heads/trunk")) {
      return jsonResponse({ object: { sha: baseSha } });
    }
    if (url.pathname.includes("/git/ref/heads/mcp-change/")) {
      return jsonResponse({ object: { sha: headSha } });
    }
    if (url.pathname.endsWith(`/commits/${headSha}/check-runs`)) {
      return jsonResponse({ total_count: 1, check_runs: [{ name: "Cloudflare Workers", status: "completed", conclusion: "success" }] });
    }
    if (url.pathname.endsWith(`/commits/${headSha}/status`)) {
      return jsonResponse({ total_count: 0, statuses: [] });
    }
    if (url.pathname.endsWith("/git/refs/heads/trunk") && init.method === "PATCH") {
      return jsonResponse({ object: { sha: headSha } });
    }
    if (url.pathname.includes("/git/refs/heads/mcp-change/") && init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ message: "not found" }, 404);
  }, () => publishImplementation({
    env: githubEnvironment(),
    token: "github-token",
    branch: "mcp-change/20260906t120000z-example",
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
  }));

  const publishRequest = requests.find((request) => request.method === "PATCH");
  assert.equal(result.published, true);
  assert.equal(result.temporary_branch_deleted, true);
  assert.deepEqual(publishRequest.body, { sha: headSha, force: false });
  assert.equal(requests.some((request) => request.path.includes("/pulls")), false);
  assert.equal(requests.some((request) => request.method === "DELETE" && request.path.includes("/mcp-change/")), true);
});

test("implementation status remains missing when no CI check exists", async () => {
  const headSha = "e".repeat(40);
  const result = await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/git/ref/heads/mcp-change/")) {
      return jsonResponse({ object: { sha: headSha } });
    }
    if (url.pathname.endsWith("/check-runs")) {
      return jsonResponse({ total_count: 0, check_runs: [] });
    }
    return jsonResponse({ total_count: 0, statuses: [] });
  }, () => getImplementationStatus({
    env: githubEnvironment(),
    token: "github-token",
    branch: "mcp-change/20260906t120000z-example",
    expectedHeadSha: headSha,
    waitSeconds: 0,
  }));

  assert.equal(result.validation_status, "missing");
});

test("implementation status requires the configured check by exact name", async () => {
  const headSha = "e".repeat(40);
  const result = await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/git/ref/heads/mcp-change/")) {
      return jsonResponse({ object: { sha: headSha } });
    }
    if (url.pathname.endsWith("/check-runs")) {
      return jsonResponse({
        total_count: 1,
        check_runs: [{ name: "Unrelated check", status: "completed", conclusion: "success" }],
      });
    }
    return jsonResponse({ total_count: 0, statuses: [] });
  }, () => getImplementationStatus({
    env: githubEnvironment(),
    token: "github-token",
    branch: "mcp-change/20260906t120000z-example",
    expectedHeadSha: headSha,
    waitSeconds: 0,
  }));

  assert.equal(result.validation_status, "missing");
  assert.deepEqual(result.required_checks, ["Cloudflare Workers"]);
  assert.deepEqual(result.missing_required_checks, ["Cloudflare Workers"]);
});

test("implementation status fails closed without required check configuration", async () => {
  const headSha = "e".repeat(40);
  const result = await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/git/ref/heads/mcp-change/")) {
      return jsonResponse({ object: { sha: headSha } });
    }
    if (url.pathname.endsWith("/check-runs")) {
      return jsonResponse({
        total_count: 1,
        check_runs: [{ name: "Cloudflare Workers", status: "completed", conclusion: "success" }],
      });
    }
    return jsonResponse({ total_count: 0, statuses: [] });
  }, () => getImplementationStatus({
    env: githubEnvironment({ GITHUB_REQUIRED_CHECK_NAMES: undefined }),
    token: "github-token",
    branch: "mcp-change/20260906t120000z-example",
    expectedHeadSha: headSha,
    waitSeconds: 0,
  }));

  assert.equal(result.validation_status, "missing");
  assert.deepEqual(result.required_checks, []);
});

test("failed implementation status returns diagnostics and an autonomous repair action", async () => {
  const headSha = "e".repeat(40);
  const result = await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/git/ref/heads/mcp-change/")) {
      return jsonResponse({ object: { sha: headSha } });
    }
    if (url.pathname.endsWith("/check-runs")) {
      return jsonResponse({
        total_count: 1,
        check_runs: [{
          id: 42,
          name: "Cloudflare Workers",
          status: "completed",
          conclusion: "failure",
          output: { title: "Build failed", summary: "npm test failed" },
        }],
      });
    }
    return jsonResponse({ total_count: 0, statuses: [] });
  }, () => getImplementationStatus({
    env: githubEnvironment(),
    token: "github-token",
    branch: "mcp-change/20260906t120000z-example",
    expectedHeadSha: headSha,
    waitSeconds: 0,
  }));

  assert.equal(result.validation_status, "failed");
  assert.equal(result.needs_follow_up, true);
  assert.equal(result.checks[0].output_summary, "npm test failed");
  assert.match(result.next_action, /same branch/);
});

test("active page registry uses structured YAML and a configured post number", () => {
  const registry = parseActivePageRegistry(`
# Registry

\`\`\`yaml
registry_version: 1
scope: control_plane
pages:
  - post: 6
    role: entry
    auto_read: always
    freshness: [context_version, revision]
    successor: null
    routes: [115]
\`\`\`
`);

  assert.equal(registry.pages[0].role, "entry");
  assert.equal(resolveActivePageRegistryPostNumber(undefined, { ESA_ACTIVE_PAGE_REGISTRY_POST_NUMBER: "690" }), 690);
  assert.throws(
    () => parseActivePageRegistry("```yaml\nregistry_version: 1\nregistry_version: 2\n```"),
    (error) => error.domainStatus === "registry_yaml_invalid",
  );
});

test("active page registry lint reports archived, missing, and unobserved targets", async () => {
  const registryBody = `\`\`\`yaml
registry_version: 1
scope: control_plane
pages:
  - post: 6
    role: entry
    auto_read: always
    freshness: [revision]
    successor: null
    routes: [115, 999]
  - post: 115
    role: entry
    auto_read: first_context_answer
    freshness: [revision, kv_observer]
    successor: null
    routes: []
\`\`\``;
  const env = {
    MCP_CONFIG: memoryKv({
      "context_observer:example-team": JSON.stringify({
        schema: "esa_mcp.context_observer.kv.v1",
        team_name: "example-team",
        observed_posts: [{ post_number: 6 }],
      }),
    }),
  };

  const result = await withFetch(async (input) => {
    const postNumber = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    if (postNumber === 690) {
      return jsonResponse({ number: 690, full_name: "KnowledgeBase/system/active-page-registry.md", revision_number: 4, body_md: registryBody });
    }
    if (postNumber === 6) {
      return jsonResponse({ number: 6, full_name: "KnowledgeBase/active.md" });
    }
    if (postNumber === 115) {
      return jsonResponse({ number: 115, full_name: "Archived/KnowledgeBase/assistant-response-style.md" });
    }
    return jsonResponse({ error: "not_found" }, 404);
  }, () => lintActivePageRegistry({
    env,
    teamName: "example-team",
    token: "test-token",
    registryPostNumber: 690,
  }));

  assert.equal(result.status, "issues");
  assert.equal(result.checked_post_count, 3);
  assert.ok(result.issues.some((issue) => issue.code === "duplicate_role" && issue.role === "entry"));
  assert.ok(result.issues.some((issue) => issue.code === "archived_post" && issue.post_number === 115));
  assert.ok(result.issues.some((issue) => issue.code === "archived_target" && issue.post_number === 115));
  assert.ok(result.issues.some((issue) => issue.code === "missing_target" && issue.post_number === 999));
  assert.ok(result.issues.some((issue) => issue.code === "observer_missing" && issue.post_number === 115));
});

test("context entry uses the configured post number", () => {
  assert.equal(resolveContextEntryPostNumber(undefined, { ESA_CONTEXT_ENTRY_POST_NUMBER: "123" }), 123);
  assert.equal(resolveContextEntryPostNumber(35, { ESA_CONTEXT_ENTRY_POST_NUMBER: "123" }), 35);
  assert.equal(resolveContextSummaryPostNumber(undefined, { ESA_CONTEXT_SUMMARY_POST_NUMBER: "620" }), 620);
});

test("team name uses the deployment default when omitted", () => {
  assert.equal(resolveTeamName(undefined, { ESA_DEFAULT_TEAM: "configured-team" }), "configured-team");
  assert.equal(resolveTeamName("override-team", { ESA_DEFAULT_TEAM: "configured-team" }), "override-team");
});

test("context entry returns only markdown and essential metadata", async () => {
  await withFetch(async () => jsonResponse({
    number: 6,
    name: "active.md",
    full_name: "KnowledgeBase/active.md",
    url: "https://example-team.esa.io/posts/123",
    revision_number: 31,
    updated_at: "2026-09-01T18:45:13+09:00",
    body_md: "# active.md",
    body_html: "<h1>active.md</h1>",
  }), async () => {
    const result = await loadContextEntry({ teamName: "example-team", token: "token", postNumber: 6 });
    const toolResult = createContextResult(result);

    assert.equal(result.summary_status, "not_configured");
    assert.equal(Object.hasOwn(result, "context_status"), false);
    assert.equal(Object.hasOwn(result, "response_action"), false);
    assert.equal(result.entry.body_md, "# active.md");
    assert.equal(result.entry.body_html, undefined);
    assert.doesNotMatch(toolResult.content[0].text, /active\.md/);
  });
});

test("context entry loads the current summary in parallel", async () => {
  const requested = [];
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    requested.push(number);
    return jsonResponse({
      number,
      name: number === 6 ? "active.md" : "current-summary.md",
      body_md: number === 6 ? "# active.md" : "# Current summary",
      body_html: `<h1>${number}</h1>`,
      revision_number: 1,
    });
  }, async () => {
    const result = await loadContextEntry({
      teamName: "example-team",
      token: "summary-token",
      postNumber: 6,
      summaryPostNumber: 620,
      includeSummary: true,
    });

    assert.deepEqual(requested.sort((a, b) => a - b), [6, 620]);
    assert.equal(result.entry.body_md, "# active.md");
    assert.equal(result.current_summary.body_md, "# Current summary");
    assert.equal(Object.hasOwn(result, "answer_instruction"), false);
    assert.equal("body_html" in result.current_summary, false);
  });
});

test("context entry limits the default summary payload", async () => {
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    return jsonResponse({
      number,
      name: number === 6 ? "active.md" : "current-summary.md",
      body_md: number === 6 ? "# active.md" : "x".repeat(2_000),
      revision_number: 1,
    });
  }, async () => {
    const result = await loadContextEntry({
      teamName: "example-team",
      token: "summary-limit-token",
      postNumber: 6,
      summaryPostNumber: 620,
      includeSummary: true,
    });

    assert.equal(result.current_summary.body_md.length, 1_200);
    assert.equal(result.current_summary.next_start_char, 1_200);
    assert.equal(result.current_summary.truncated, true);
  });
});

test("context entry leaves a configured summary available on demand by default", async () => {
  const requested = [];
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    requested.push(number);
    return jsonResponse({ number, name: "active.md", body_md: "# active.md", revision_number: 1 });
  }, async () => {
    const result = await loadContextEntry({
      teamName: "example-team",
      token: "summary-token",
      postNumber: 6,
      summaryPostNumber: 620,
    });

    assert.deepEqual(requested, [6]);
    assert.equal(result.summary_status, "available_on_demand");
    assert.equal(result.summary_post_number, 620);
    assert.equal(result.current_summary, undefined);
  });
});

test("context entry prefetches explicit articles in parallel and removes duplicate reads", async () => {
  const requested = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    requested.push(number);
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    return jsonResponse({
      number,
      name: `post-${number}.md`,
      body_md: `# Post ${number}\n\n## Details\n\nBody`,
      revision_number: number,
    });
  }, async () => {
    const result = await loadContextEntry({
      teamName: "example-team",
      token: "prefetch-token",
      postNumber: 6,
      prefetchPosts: [
        { postNumber: 73, mode: "markdown" },
        { postNumber: 35, mode: "outline" },
        { postNumber: 73, mode: "outline" },
        { postNumber: 6, mode: "markdown" },
      ],
    });

    assert.deepEqual(requested.sort((a, b) => a - b), [6, 35, 73]);
    assert.equal(maxActiveRequests, 3);
    assert.deepEqual(result.prefetched_posts.map((item) => [item.post_number, item.mode, item.status]), [
      [73, "markdown", "success"],
      [35, "outline", "success"],
    ]);
    assert.equal(result.prefetched_posts[0].result.body_md, "# Post 73\n\n## Details\n\nBody");
    assert.equal(result.prefetched_posts[1].result.heading_count, 2);
    assert.equal(result.prefetched_posts[1].result.body_md, undefined);
  });
});

test("optional context prefetch failures do not discard the entry", async () => {
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    return number === 6
      ? jsonResponse({ number, name: "active.md", body_md: "# active.md", revision_number: 1 })
      : jsonResponse({ message: "Not Found" }, 404);
  }, async () => {
    const result = await loadContextEntry({
      teamName: "example-team",
      token: "prefetch-token",
      postNumber: 6,
      prefetchPosts: [{ postNumber: 999, mode: "markdown" }],
    });

    assert.equal(result.entry.number, 6);
    assert.equal(result.prefetched_posts[0].status, "failed");
    assert.equal(result.prefetched_posts[0].error.domain_status, "esa_post_not_found");
    assert.equal(typeof result.prefetched_posts[0].error.message_ja, "string");
  });
});

test("post outline includes document metrics without the body", async () => {
  const bodyMd = "# Title\n\nIntro.\n\n## First\n\nText.\n\n## Second\n";
  await withFetch(async () => jsonResponse({
    number: 35,
    name: "operation.md",
    full_name: "KnowledgeBase/operation.md",
    body_md: bodyMd,
    revision_number: 9,
  }), async () => {
    const view = await getPostsModelView({
      teamName: "example-team",
      token: "token",
      postNumbers: [35],
      mode: "outline",
      maxHeadings: 2,
    });
    const result = view.posts[0].result;

    assert.equal(result.body_chars, bodyMd.length);
    assert.equal(result.body_bytes, new TextEncoder().encode(bodyMd).length);
    assert.equal(result.body_lines, 10);
    assert.equal(result.heading_count, 3);
    assert.equal(result.headings_truncated, true);
    assert.equal(result.outline.length, 2);
    assert.equal(result.body_md, undefined);
  });
});

test("model read shares one character budget across parallel Markdown posts", async () => {
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    return jsonResponse({ number, name: `post-${number}.md`, body_md: "abcdefghij", revision_number: 1 });
  }, async () => {
    const result = await getPostsModelView({
      teamName: "example-team",
      token: "token",
      postNumbers: [73, 78],
      mode: "markdown",
      maxChars: 10,
    });

    assert.equal(result.total_max_chars, 10);
    assert.equal(result.per_post_max_chars, 5);
    assert.deepEqual(result.posts.map((post) => post.result.body_md), ["abcde", "abcde"]);
    assert.deepEqual(result.posts.map((post) => post.result.next_start_char), [5, 5]);
  });
});

test("excerpt mode selects relevant blocks and removes link destinations", async () => {
  const bodyMd = [
    "# Note",
    "",
    "Unrelated introduction.",
    "",
    "## Relationship",
    "",
    "プロジェクト要件とリリース計画についての記録。[source](https://example.com/long/path)",
    "",
    "## Other",
    "",
    "Unrelated ending.",
  ].join("\n");
  await withFetch(async () => jsonResponse({ number: 73, name: "note.md", body_md: bodyMd, revision_number: 2 }), async () => {
    const result = await getPostsModelView({
      teamName: "example-team",
      token: "token",
      postNumbers: [73],
      mode: "excerpt",
      query: "プロジェクト要件とリリース計画",
      maxChars: 120,
    });
    const excerpt = result.posts[0].result.excerpt_md;

    assert.match(excerpt, /プロジェクト要件とリリース計画/);
    assert.doesNotMatch(excerpt, /https:\/\//);
    assert.ok(excerpt.length <= 120);
  });
});

test("section reads enforce one combined character budget", async () => {
  const bodyMd = "# First\n123456\n\n# Second\nabcdef";
  await withFetch(async () => jsonResponse({ number: 35, name: "operation.md", body_md: bodyMd, revision_number: 3 }), async () => {
    const result = await readPostSections({
      teamName: "example-team",
      token: "token",
      postNumber: 35,
      maxChars: 10,
      sections: [
        { heading: "First" },
        { heading: "Second" },
      ],
    });

    assert.equal(result.max_chars, 10);
    assert.equal(result.sections.reduce((total, section) => total + section.body_md.length, 0), 10);
    assert.equal(result.sections[1].truncated, true);
  });
});

test("fast MCP profile exposes only focused read tools", () => {
  const fastServer = createServer(
    {},
    "token",
    new Request("https://mcp.example.com/mcp-fast"),
    { waitUntil() {} },
    undefined,
    "fast",
  );
  assert.deepEqual(Object.keys(fastServer._registeredTools).sort(), [
    "esa_check_context_drift",
    "esa_get_post",
    "esa_load_context_entry",
    "esa_read_sections",
    "esa_search_posts",
  ]);

  const fullServer = createServer(
    {},
    "token",
    new Request("https://mcp.example.com/mcp"),
    { waitUntil() {} },
    undefined,
    "full",
  );
  assert.equal(Boolean(fullServer._registeredTools.esa_lint_active_page_registry), true);
  assert.equal(Boolean(fullServer._registeredTools.esa_bulk_update_posts), true);
  assert.equal(Boolean(fullServer._registeredTools.repo_get_snapshot), true);
  assert.equal(Boolean(fullServer._registeredTools.repo_read_files), true);
  assert.equal(Boolean(fullServer._registeredTools.repo_create_implementation_branch), true);
  assert.equal(Boolean(fullServer._registeredTools.repo_get_implementation_status), true);
  assert.equal(Boolean(fullServer._registeredTools.repo_publish_implementation), true);
});

test("context drift reads its baseline from KV", async () => {
  const kv = memoryKv({
    "context_observer:example-team": JSON.stringify({
      schema: "esa_mcp.context_observer.kv.v1",
      team_name: "example-team",
      observed_posts: [{ post_number: 6, last_seen_revision_number: 3 }],
    }),
  });
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    return jsonResponse({ number: 6, revision_number: 3 });
  }, async () => {
    const result = await checkContextDrift({
      env: { MCP_CONFIG: kv },
      teamName: "example-team",
      token: "observer-token",
    });

    assert.equal(result.status, "unchanged");
    assert.equal(result.changed_count, 0);
    assert.equal(result.observer.storage, "cloudflare_kv");
  });
});

test("legacy observer is imported to KV without esa writes", async () => {
  const legacyBody = '```json\n{"schema":"esa_mcp.context_update_check.v1","context_version":"1","team_name":"example-team","observed_posts":[{"post_number":6,"last_seen_revision_number":2}]}\n```';
  let patchRequests = 0;
  const kv = memoryKv();

  await withFetch(async (input, init) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    const method = init?.method ?? "GET";
    if (method === "PATCH") {
      patchRequests += 1;
      return jsonResponse({ number: 121, revision_number: 5 });
    }
    if (number === 121) {
      return jsonResponse({ number: 121, body_md: legacyBody, revision_number: 4 });
    }
    return jsonResponse({ number: 6, revision_number: 3, updated_at: "2026-09-02T00:00:00+09:00" });
  }, async () => {
    await refreshContextObserver({
      env: { MCP_CONFIG: kv },
      teamName: "example-team",
      token: "refresh-token",
      observerPostNumber: 121,
    });
  });
  const manifest = await readContextObserverManifest({ MCP_CONFIG: kv }, "example-team");

  assert.equal(patchRequests, 0);
  assert.equal(manifest.schema, "esa_mcp.context_observer.kv.v1");
  assert.equal(manifest.observed_posts[0].last_seen_revision_number, 3);
});

test("successful MCP writes can advance monitored KV baselines", async () => {
  const kv = memoryKv({
    "context_observer:example-team": JSON.stringify({
      schema: "esa_mcp.context_observer.kv.v1",
      team_name: "example-team",
      observed_posts: [
        { post_number: 6, title: "active.md", last_seen_revision_number: 3 },
        { post_number: 35, title: "operation.md", last_seen_revision_number: 8 },
      ],
    }),
  });

  const result = await syncObservedPostBaselines({ MCP_CONFIG: kv }, "example-team", [
    {
      post_number: 6,
      title: "active.md",
      revision_number: 4,
      updated_at: "2026-09-05T12:00:00+09:00",
      context_version: "2026-09-05.4",
    },
    { post_number: 999, revision_number: 1 },
  ]);
  const manifest = await readContextObserverManifest({ MCP_CONFIG: kv }, "example-team");

  assert.equal(result.updated, 1);
  assert.equal(manifest.observed_posts[0].last_seen_revision_number, 4);
  assert.equal(manifest.observed_posts[0].expected_context_version, "2026-09-05.4");
  assert.equal(manifest.observed_posts[1].last_seen_revision_number, 8);
});

test("multi-post markdown read removes rendered HTML", async () => {
  await withFetch(async (input) => {
    const number = Number(/\/posts\/(\d+)/.exec(String(input))?.[1]);
    return jsonResponse({
      number,
      name: `post-${number}.md`,
      body_md: `# Post ${number}`,
      body_html: `<h1>Post ${number}</h1>`,
      revision_number: number,
    });
  }, async () => {
    const result = await getPostsModelView({
      teamName: "example-team",
      token: "markdown-token",
      postNumbers: [73, 78, 73],
      mode: "markdown",
    });

    assert.deepEqual(result.posts.map((post) => post.result.number), [73, 78]);
    assert.deepEqual(result.posts.map((post) => post.result.body_md), ["# Post 73", "# Post 78"]);
    assert.equal(result.posts.some((post) => "body_html" in post.result), false);
  });
});

test("post command returns markdown without rendered HTML", async () => {
  await withFetch(async () => jsonResponse({
    number: 6,
    name: "active.md",
    body_md: "# Active",
    body_html: "<h1>Active</h1>",
    revision_number: 3,
  }), async () => {
    const result = await runEsaCommand("#123", "example-team", "command-token");

    assert.equal(result.body_md, "# Active");
    assert.equal("body_html" in result, false);
  });
});

test("command aliases and collection reads use the same post endpoints", async () => {
  const requests = [];
  await withFetch(async (input) => {
    const url = new URL(input);
    requests.push(`${url.pathname}${url.search}`);
    return jsonResponse({ items: [] });
  }, async () => {
    for (const command of ["comments 42", "c 42", "backlinks 42", "b 42"]) {
      await runEsaCommand(command, "example-team", "command-token");
    }
    await getPostCollection({
      teamName: "example-team",
      token: "command-token",
      postNumber: 42,
      collection: "comments",
      page: 2,
      perPage: 10,
    });
  });

  assert.deepEqual(requests, [
    "/v1/teams/example-team/posts/42/comments",
    "/v1/teams/example-team/posts/42/comments",
    "/v1/teams/example-team/posts/42/backlinks",
    "/v1/teams/example-team/posts/42/backlinks",
    "/v1/teams/example-team/posts/42/comments?page=2&per_page=10",
  ]);
});

test("post command view aliases select outline and metadata", async () => {
  await withFetch(async () => jsonResponse({
    number: 42,
    name: "Example",
    body_md: "# Heading\nBody",
  }), async () => {
    const outline = await runEsaCommand("toc 42", "example-team", "command-token");
    const compact = await runEsaCommand("compact 42", "example-team", "command-token");

    assert.equal(outline.outline[0].heading, "Heading");
    assert.equal(compact.number, 42);
    assert.equal("body_md" in compact, false);
    assert.equal("outline" in compact, false);
  });
});

test("single body update sends original_revision", async () => {
  const requests = [];
  await withFetch(async (_input, init) => {
    const method = init?.method ?? "GET";
    requests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") {
      return jsonResponse({
        number: 6,
        name: "active.md",
        body_md: "old body",
        revision_number: 7,
        updated_by: { screen_name: "example-team" },
      });
    }
    return jsonResponse({ number: 6, name: "active.md", revision_number: 8 });
  }, async () => {
    const result = await updatePost({
      teamName: "example-team",
      token: "update-token",
      postNumber: 6,
      bodyMd: "new body",
      expectedRevisionNumber: 7,
    });

    assert.equal(result.revision_number, 8);
    assert.deepEqual(requests[1], {
      method: "PATCH",
      body: {
        post: {
          body_md: "new body",
          original_revision: { body_md: "old body", number: 7, user: "example-team" },
        },
      },
    });
  });
});

test("single update does not PATCH a stale revision", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return jsonResponse({ number: 6, body_md: "current", revision_number: 8 });
  }, async () => {
    await assert.rejects(
      updatePost({ teamName: "example-team", token: "stale-token", postNumber: 6, name: "next.md", expectedRevisionNumber: 7 }),
      (error) => error.domainStatus === "revision_conflict",
    );
  });

  assert.equal(calls, 1);
});

test("multi-search keeps independent results and full query inputs", async () => {
  await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("q") === "bad") {
      return jsonResponse({ error: "invalid_query" }, 400);
    }
    return jsonResponse({
      total_count: 1,
      page: Number(url.searchParams.get("page") ?? 1),
      per_page: 20,
      posts: [{ number: 6, name: "active.md", body_md: "context_version: 1" }],
    });
  }, async () => {
    const result = await searchPostsMulti({
      teamName: "example-team",
      token: "token",
      queries: [{ q: "active", page: 2 }, { q: "bad", page: 3 }],
    });

    assert.deepEqual({ total: result.total, succeeded: result.succeeded, failed: result.failed }, { total: 2, succeeded: 1, failed: 1 });
    assert.deepEqual(result.queries[0].query, { q: "active", page: 2 });
    assert.equal(result.queries[0].status, "ok");
    assert.deepEqual(result.queries[1].query, { q: "bad", page: 3 });
    assert.equal(result.queries[1].status, "error");
    assert.equal(result.queries[1].error.domain_status, "esa_request_failed");
  });
});

test("multi-search reports its own query limit status", async () => {
  await assert.rejects(
    searchPostsMulti({
      teamName: "example-team",
      token: "token",
      queries: Array.from({ length: SEARCH_QUERIES_MAX_COUNT + 1 }, (_, index) => ({ q: String(index) })),
    }),
    (error) => error.domainStatus === "multi_search_limit_exceeded",
  );
});

test("bulk create sends posts in order and returns compact results", async () => {
  const requests = [];
  await withFetch(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const number = 100 + requests.length;
    return jsonResponse(
      {
        number,
        name: request.post.name,
        category: request.post.category,
        body_md: request.post.body_md,
        body_html: "<p>not returned</p>",
        revision_number: 1,
      },
      200,
      { "x-ratelimit-limit": "300", "x-ratelimit-remaining": String(300 - requests.length) },
    );
  }, async () => {
    const result = await bulkCreatePosts({
      teamName: "example-team",
      token: "token",
      posts: [
        { name: "first.md", bodyMd: "first", category: "notes" },
        { name: "second.md", bodyMd: "second", tags: ["test"] },
      ],
    });

    assert.deepEqual(requests.map((request) => request.post.name), ["first.md", "second.md"]);
    assert.deepEqual({ total: result.total, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped }, {
      total: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    });
    assert.equal(result.results[0].post.number, 101);
    assert.equal("body_html" in result.results[0].post, false);
  });
});

test("bulk create stops sending after a shared authentication failure", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return jsonResponse({ error: "unauthorized" }, 401);
  }, async () => {
    const result = await bulkCreatePosts({
      teamName: "example-team",
      token: "expired-token",
      posts: [{ name: "first.md" }, { name: "second.md" }],
    });

    assert.equal(calls, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.results[1].error.domain_status, "bulk_create_aborted");
  });
});

test("bulk create reports its own post limit status", async () => {
  await assert.rejects(
    bulkCreatePosts({
      teamName: "example-team",
      token: "token",
      posts: Array.from({ length: BULK_CREATE_POSTS_MAX_COUNT + 1 }, (_, index) => ({ name: `post-${index}.md` })),
    }),
    (error) => error.domainStatus === "bulk_create_limit_exceeded",
  );
});

test("category batch move uses the esa category endpoint", async () => {
  let request;
  await withFetch(async (input, init) => {
    request = { url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) };
    return jsonResponse({ count: 3, from: "/foo/", to: "/bar/" });
  }, async () => {
    const result = await batchMoveCategory({
      teamName: "example-team",
      token: "token",
      from: "/foo/",
      to: "/bar/",
    });

    assert.equal(result.count, 3);
    assert.match(request.url, /\/teams\/example-team\/categories\/batch_move$/);
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body, { from: "/foo/", to: "/bar/" });
  });
});

test("category batch move rejects identical paths before sending", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return jsonResponse({});
  }, async () => {
    await assert.rejects(
      batchMoveCategory({ teamName: "example-team", token: "token", from: "/same/", to: "/same/" }),
      (error) => error.domainStatus === "category_move_no_change",
    );
  });
  assert.equal(calls, 0);
});

test("category batch move clears cached post categories for the team", async () => {
  let category = "before";
  let postReads = 0;
  await withFetch(async (input, init) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST") {
      category = "after";
      return jsonResponse({ count: 1, from: "/before/", to: "/after/" });
    }
    postReads += 1;
    return jsonResponse({ number: 98765, name: "cached.md", category });
  }, async () => {
    const read = () => esaGet({ teamName: "cache-test-team", path: "/posts/98765", token: "cache-test-token" });
    assert.equal((await read()).category, "before");
    assert.equal((await read()).category, "before");
    assert.equal(postReads, 1);

    await batchMoveCategory({
      teamName: "cache-test-team",
      token: "cache-test-token",
      from: "/before/",
      to: "/after/",
    });

    assert.equal((await read()).category, "after");
    assert.equal(postReads, 2);
  });
});

test("bulk body update sends original_revision", async () => {
  const requests = [];
  await withFetch(async (_input, init) => {
    const method = init?.method ?? "GET";
    requests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") {
      return jsonResponse(
        {
          number: 6,
          name: "active.md",
          body_md: "old body",
          revision_number: 7,
          updated_by: { screen_name: "example-team" },
        },
        200,
        { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "299", "x-ratelimit-reset": "1800000000" },
      );
    }
    return jsonResponse(
      { number: 6, name: "active.md", revision_number: 8 },
      200,
      { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "298", "x-ratelimit-reset": "1800000000" },
    );
  }, async () => {
    const result = await bulkUpdatePosts({
      teamName: "example-team",
      token: "token",
      posts: [{ postNumber: 6, bodyMd: "new body", expectedRevisionNumber: 7 }],
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      method: "PATCH",
      body: {
        post: {
          body_md: "new body",
          original_revision: { body_md: "old body", number: 7, user: "example-team" },
        },
      },
    });
    assert.deepEqual(
      { total: result.total, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped },
      { total: 1, succeeded: 1, failed: 0, skipped: 0 },
    );
  });
});

test("bulk update stops sending after a shared authentication failure", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return jsonResponse({ error: "forbidden" }, 403);
  }, async () => {
    const result = await bulkUpdatePosts({
      teamName: "example-team",
      token: "token",
      posts: [
        { postNumber: 1, tags: ["a"] },
        { postNumber: 2, tags: ["b"] },
        { postNumber: 3, tags: ["c"] },
      ],
    });

    assert.equal(calls, 1);
    assert.deepEqual(
      { total: result.total, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped },
      { total: 3, succeeded: 0, failed: 1, skipped: 2 },
    );
    assert.deepEqual(result.results.map((item) => item.status), ["error", "skipped", "skipped"]);
    assert.equal(result.results[1].error.domain_status, "bulk_update_aborted");
    assert.equal(result.results[1].error.details.cause_domain_status, "esa_write_permission_required");
  });
});

test("bulk update does not PATCH a stale expected revision", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return jsonResponse({ number: 6, body_md: "current", revision_number: 8 });
  }, async () => {
    const result = await bulkUpdatePosts({
      teamName: "example-team",
      token: "token",
      posts: [{ postNumber: 6, tags: ["updated"], expectedRevisionNumber: 7 }],
    });

    assert.equal(calls, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].error.domain_status, "revision_conflict");
  });
});

test("bulk update does not count rate-limit skips as failures", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return jsonResponse(
      { number: 1, name: "one" },
      200,
      { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
    );
  }, async () => {
    const result = await bulkUpdatePosts({
      teamName: "example-team",
      token: "token",
      posts: [{ postNumber: 1, tags: ["a"] }, { postNumber: 2, tags: ["b"] }],
    });

    assert.equal(calls, 1);
    assert.deepEqual(
      { total: result.total, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped },
      { total: 2, succeeded: 1, failed: 0, skipped: 1 },
    );
    assert.equal(result.results[1].error.domain_status, "esa_rate_limited");
    assert.equal(result.results[1].error.http_status, 429);
  });
});

test("bulk update reports its own post limit status", async () => {
  try {
    await bulkUpdatePosts({
      teamName: "example-team",
      token: "token",
      posts: Array.from({ length: BULK_UPDATE_POSTS_MAX_COUNT + 1 }, (_, index) => ({ postNumber: index + 1, wip: false })),
    });
    assert.fail("Expected bulkUpdatePosts to reject");
  } catch (error) {
    assert.equal(normalizeToolError(error).domain_status, "bulk_update_limit_exceeded");
  }
});

async function issueAccessToken(env, resource, scope = OAuthScope.Read) {
  const verifier = "test-code-verifier-with-sufficient-length";
  const authorizeParams = oauthParameters({
    passcode: "test-passcode",
    esa_access_token: "secret-esa-token",
    code_challenge: await sha256Base64Url(verifier),
    scope,
    resource,
  });
  const authorization = await withFetch(
    async () => jsonResponse({ number: 6, revision_number: 1 }),
    () => oauthAuthorize(oauthRequest(HttpMethod.Post, authorizeParams), env),
  );
  const code = new URL(authorization.headers.get("Location")).searchParams.get("code");
  return oauthToken(oauthTokenRequest(new URLSearchParams({
    grant_type: OAuthGrantType.AuthorizationCode,
    code,
    redirect_uri: authorizeParams.get("redirect_uri"),
    client_id: authorizeParams.get("client_id"),
    code_verifier: verifier,
    resource,
  })), env);
}

function mcpRequest(path, token, body) {
  return new Request(`https://mcp.example.com${path}`, {
    method: HttpMethod.Post,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });
}

async function mcpResult(response) {
  const text = await response.text();
  const data = text.split("\n").filter((line) => line.startsWith("data:")).at(-1)?.slice(5) ?? text;
  return JSON.parse(data);
}

test("both MCP endpoints route to their own tool catalog", async () => {
  clearConfigCache();
  const env = oauthEnvironment();
  const { access_token: token } = await (await issueAccessToken(env, "https://mcp.example.com", OAUTH_SCOPE_ALL)).json();
  const ctx = { waitUntil() {} };
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

  const fast = await worker.fetch(mcpRequest("/mcp-fast", token, list), env, ctx);
  assert.equal(fast.status, 200);
  const fastNames = (await mcpResult(fast)).result.tools.map((tool) => tool.name);
  assert.ok(fastNames.includes("esa_get_post"));
  assert.equal(fastNames.includes("esa_create_post"), false);

  const full = await worker.fetch(mcpRequest("/mcp", token, list), env, ctx);
  assert.equal(full.status, 200);
  assert.ok((await mcpResult(full)).result.tools.some((tool) => tool.name === "esa_create_post"));
});

test("OAuth accepts RFC 8707 endpoint resource indicators and binds the audience", async () => {
  clearConfigCache();
  const env = oauthEnvironment();
  const exchange = await issueAccessToken(env, "https://mcp.example.com/mcp-fast");
  assert.equal(exchange.status, 200);
  const { access_token: token } = await exchange.json();

  const sameEndpoint = await authenticateMcpRequest(
    new Request("https://mcp.example.com/mcp-fast", { headers: { Authorization: `Bearer ${token}` } }),
    env,
    MCP_PROFILE_REQUIRED_SCOPES[McpProfile.Fast],
  );
  assert.equal(sameEndpoint instanceof Response, false);

  const otherEndpoint = await authenticateMcpRequest(
    new Request("https://mcp.example.com/mcp", { headers: { Authorization: `Bearer ${token}` } }),
    env,
    MCP_PROFILE_REQUIRED_SCOPES[McpProfile.Fast],
  );
  assert.equal(otherEndpoint.status, HttpStatusCode.Unauthorized);

  const request = new Request("https://mcp.example.com/oauth/token");
  assert.equal(canonicalResource(request, "https://mcp.example.com/mcp/"), "https://mcp.example.com/mcp");
  assert.equal(canonicalResource(request, null), "https://mcp.example.com");
  assert.equal(canonicalResource(request, "https://attacker.example"), undefined);

  const foreign = await withFetch(
    async () => jsonResponse({ number: 6, revision_number: 1 }),
    () => oauthAuthorize(oauthRequest(HttpMethod.Post, oauthParameters({
      passcode: "test-passcode",
      esa_access_token: "secret-esa-token",
      resource: "https://attacker.example",
    })), env),
  );
  assert.equal(foreign.status, HttpStatusCode.BadRequest);
  assert.equal((await foreign.json()).error, OAuthErrorCode.InvalidTarget);
});

test("protected resource metadata names each MCP endpoint", async () => {
  const fast = await protectedResourceMetadata(new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp-fast")).json();
  assert.equal(fast.resource, "https://mcp.example.com/mcp-fast");
  assert.deepEqual(fast.scopes_supported, [OAuthScope.Read]);

  const bare = await protectedResourceMetadata(new Request("https://mcp.example.com/.well-known/oauth-protected-resource")).json();
  assert.equal(bare.resource, "https://mcp.example.com");

  const unknown = protectedResourceMetadata(new Request("https://mcp.example.com/.well-known/oauth-protected-resource/admin"));
  assert.equal(unknown.status, HttpStatusCode.NotFound);

  clearConfigCache();
  const challenge = await authenticateMcpRequest(new Request("https://mcp.example.com/mcp-fast"), oauthEnvironment(), [OAuthScope.Read]);
  assert.match(challenge.headers.get("WWW-Authenticate"), /oauth-protected-resource\/mcp-fast"/);
});

test("preview E2E bearer works only on its own version preview host and never reaches esa", async () => {
  const env = oauthEnvironment({
    MCP_E2E_PREVIEW_BEARER_TOKEN: "preview-secret",
    CF_VERSION_METADATA: { id: "abcdef12-3456-7890-abcd-ef1234567890" },
  });
  const previewHost = "https://abcdef12-esa-mcp-worker.example.workers.dev/mcp";
  const productionHost = "https://esa-mcp-worker.example.workers.dev/mcp";

  assert.ok(previewAuthentication(new Request(previewHost), env, "preview-secret"));
  assert.equal(previewAuthentication(new Request(previewHost), env, "wrong-secret"), undefined);
  assert.equal(previewAuthentication(new Request(productionHost), env, "preview-secret"), undefined);
  assert.equal(previewAuthentication(new Request(previewHost), { ...env, MCP_E2E_PREVIEW_BEARER_TOKEN: undefined }, "preview-secret"), undefined);

  const preview = previewAuthentication(new Request(previewHost), env, "preview-secret");
  let fetched = false;
  await withFetch(async () => {
    fetched = true;
    return jsonResponse({});
  }, async () => {
    await assert.rejects(esaGet({ teamName: "example-team", path: "/posts/1", token: preview.esaToken }), /cannot call the esa API/);
  });
  assert.equal(fetched, false);
});

test("Worker responses expose the exact Cloudflare runtime version", async () => {
  const versionId = "abcdef12-3456-7890-abcd-ef1234567890";
  const response = await worker.fetch(
    new Request("https://mcp.example.com/"),
    { CF_VERSION_METADATA: { id: versionId } },
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-MCP-Runtime-Version"), versionId);

  const unversioned = await worker.fetch(
    new Request("https://mcp.example.com/"),
    {},
    { waitUntil() {} },
  );
  assert.equal(unversioned.headers.has("X-MCP-Runtime-Version"), false);
});
