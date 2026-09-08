import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  DEFAULT_OAUTH_REDIRECT_HOSTS,
  E2E_PREVIEW_CLIENT_ID,
  E2E_PREVIEW_UPSTREAM_SENTINEL,
  MCP_ENDPOINT_PATHS,
  MCP_PROFILE_BY_PATH,
  MCP_PROFILE_REQUIRED_SCOPES,
  OAUTH_SCOPE,
  OAUTH_SCOPES,
  PROTECTED_RESOURCE_METADATA_PATH,
  REMEMBERED_AUTH_TTL_SECONDS,
  AuditEventType,
  HttpMethod,
  HttpStatusCode,
  OAuthClientAuthMethod,
  OAuthErrorCode,
  OAuthGrantType,
  OAuthResponseType,
  OAuthScope,
  OAuthTokenType,
  PkceCodeChallengeMethod,
  SignedPayloadKind,
} from "../core/constants";
import { bytesToBase64Url, createSignedValue, decryptText, encryptText, timingSafeEqual, verifySignedValue } from "../core/crypto";
import { currentOauthPasscode, currentSigningSecret, readBearerToken } from "../core/config";
import { normalizeScope, safeHost, writeAudit, writeConnection } from "../core/audit";
import { htmlEscape, insufficientScopeResponse, jsonResponse, readCookie, requestOrigin, requestParams, unauthorizedResponse } from "../core/http";
import { describeEsaValidationTarget, validateEsaReadAccess } from "../esa/esa";
import { isGithubAppConfigured } from "../github/github";
import { consumeOAuthAuthorizationCode } from "./oauth-code-store";
import { nowSeconds } from "../core/utils";
import type { AccessTokenPayload, AuthCodePayload, Env, EsaTokenInfo, McpAuthSuccess, RememberedAuthPayload } from "../core/types";

const REMEMBERED_AUTH_COOKIE = "esa_mcp_remembered_auth";
const OAUTH_SCOPE_SET = new Set<string>(OAUTH_SCOPES);

function oauthError(code: OAuthErrorCode, status: HttpStatusCode = HttpStatusCode.BadRequest) {
  return jsonResponse({ error: code }, { status });
}

function trimTrailingSlash(value: string) {
  return value.length > 1 && value.endsWith("/") ? value.replace(/\/+$/, "") : value;
}

function resourceIdentifiers(origin: string) {
  return [origin, ...MCP_ENDPOINT_PATHS.map((path) => `${origin}${path}`)];
}

export function canonicalResource(request: Request, requested: string | null) {
  const origin = requestOrigin(request);
  const value = trimTrailingSlash(requested?.trim() || origin);
  return resourceIdentifiers(origin).includes(value) ? value : undefined;
}

function audienceMatchesRequest(audience: string, request: Request) {
  const url = new URL(request.url);
  return audience === url.origin || audience === `${url.origin}${url.pathname}`;
}

export function previewAuthentication(request: Request, env: Env, actualToken: string): McpAuthSuccess | undefined {
  const configured = env.MCP_E2E_PREVIEW_BEARER_TOKEN;
  const versionId = env.CF_VERSION_METADATA?.id;
  if (!configured || !versionId || versionId.length < 8) {
    return undefined;
  }
  const hostMatches = new URL(request.url).hostname.startsWith(`${versionId.slice(0, 8)}-`);
  if (!hostMatches || !timingSafeEqual(actualToken, configured)) {
    return undefined;
  }
  return {
    esaToken: E2E_PREVIEW_UPSTREAM_SENTINEL,
    payload: {
      kind: SignedPayloadKind.AccessToken,
      exp: nowSeconds() + AUTH_CODE_TTL_SECONDS,
      aud: requestOrigin(request),
      scope: OAUTH_SCOPE,
      client_id: E2E_PREVIEW_CLIENT_ID,
      encrypted_esa_token: "",
      connection_id: `e2e-${versionId}`,
    },
  };
}

export async function authenticateMcpRequest(
  request: Request,
  env: Env,
  requiredScopes: readonly OAuthScope[] = OAUTH_SCOPES,
): Promise<McpAuthSuccess | Response> {
  const expectedToken = await currentSigningSecret(env);
  const actualToken = readBearerToken(request);

  if (!actualToken) {
    return unauthorizedResponse(request, "Authorization is required.", requiredScopes);
  }

  if (timingSafeEqual(actualToken, expectedToken)) {
    return unauthorizedResponse(request, "The bearer token is invalid.", requiredScopes);
  }

  const preview = previewAuthentication(request, env, actualToken);
  if (preview) {
    return preview;
  }

  const oauthToken = await verifySignedValue<AccessTokenPayload>(actualToken, expectedToken);
  if (
    oauthToken?.kind === SignedPayloadKind.AccessToken &&
    oauthToken.exp >= nowSeconds() &&
    audienceMatchesRequest(oauthToken.aud, request) &&
    oauthToken.encrypted_esa_token
  ) {
    const grantedScopes = canonicalOAuthScope(oauthToken.scope);
    if (!grantedScopes) {
      return unauthorizedResponse(request, "The bearer token contains an invalid scope.", requiredScopes);
    }
    const grantedScopeSet = new Set(normalizeScope(grantedScopes));
    if (requiredScopes.some((scope) => !grantedScopeSet.has(scope))) {
      return insufficientScopeResponse(request, requiredScopes);
    }

    const esaToken = await decryptText(oauthToken.encrypted_esa_token, expectedToken);
    if (esaToken) {
      return { esaToken, payload: oauthToken };
    }
  }

  if (oauthToken?.kind === SignedPayloadKind.AccessToken) {
    return unauthorizedResponse(request, "The bearer token is invalid or expired.", requiredScopes);
  }

  return unauthorizedResponse(request, "The bearer token is invalid.", requiredScopes);
}

export function protectedResourceMetadata(request: Request) {
  const origin = requestOrigin(request);
  const endpointPath = new URL(request.url).pathname.slice(PROTECTED_RESOURCE_METADATA_PATH.length);
  if (endpointPath && !MCP_ENDPOINT_PATHS.includes(endpointPath)) {
    return jsonResponse({ error: "not_found" }, { status: HttpStatusCode.NotFound });
  }

  return jsonResponse({
    resource: `${origin}${endpointPath}`,
    authorization_servers: [origin],
    scopes_supported: endpointPath ? MCP_PROFILE_REQUIRED_SCOPES[MCP_PROFILE_BY_PATH[endpointPath]] : OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: origin,
  });
}

export function oauthAuthorizationServerMetadata(request: Request) {
  const origin = requestOrigin(request);
  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: [OAuthResponseType.Code],
    grant_types_supported: [OAuthGrantType.AuthorizationCode],
    code_challenge_methods_supported: [PkceCodeChallengeMethod.S256],
    token_endpoint_auth_methods_supported: [OAuthClientAuthMethod.None],
    registration_endpoint_auth_methods_supported: [OAuthClientAuthMethod.None],
    scopes_supported: OAUTH_SCOPES,
  });
}

function canonicalOAuthScope(scope: string | undefined) {
  const requestedScopes = normalizeScope(scope);
  if (!requestedScopes?.length || requestedScopes.some((value) => !OAUTH_SCOPE_SET.has(value))) {
    return undefined;
  }
  const requestedScopeSet = new Set(requestedScopes);
  return OAUTH_SCOPES.filter((value) => requestedScopeSet.has(value)).join(" ");
}

function allowedRedirectHosts(env: Env) {
  return new Set(
    (env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS ?? DEFAULT_OAUTH_REDIRECT_HOSTS.join(","))
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function validatedRedirectHost(redirectUri: string | null, env: Env) {
  if (!redirectUri) {
    return undefined;
  }

  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:" || url.username || url.password || !allowedRedirectHosts(env).has(url.hostname.toLowerCase())) {
      return undefined;
    }
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function rememberedAuthCookie(value: string, maxAge = REMEMBERED_AUTH_TTL_SECONDS) {
  return `${REMEMBERED_AUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=${maxAge}`;
}

function clearRememberedAuthCookie() {
  return rememberedAuthCookie("", 0);
}

function withCookie(response: Response, cookie: string) {
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", cookie);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readRememberedAuth(request: Request, env: Env, redirectHost: string) {
  const rawCookie = readCookie(request, REMEMBERED_AUTH_COOKIE);
  if (!rawCookie) {
    return undefined;
  }

  const signingSecret = await currentSigningSecret(env);
  const payload = await verifySignedValue<RememberedAuthPayload>(rawCookie, signingSecret);
  const passcodeHash = await sha256Base64Url(await currentOauthPasscode(env));
  if (
    payload?.kind !== SignedPayloadKind.RememberedAuth ||
    payload.exp < nowSeconds() ||
    payload.redirect_host !== redirectHost ||
    !timingSafeEqual(payload.passcode_hash, passcodeHash)
  ) {
    return undefined;
  }

  const esaAccessToken = await decryptText(payload.encrypted_esa_token, signingSecret);
  if (!esaAccessToken) {
    return undefined;
  }

  return { esaAccessToken };
}

async function createRememberedAuthCookie(
  env: Env,
  redirectHost: string,
  encryptedEsaToken: string,
) {
  const signingSecret = await currentSigningSecret(env);
  const value = await createSignedValue(
    {
      kind: SignedPayloadKind.RememberedAuth,
      exp: nowSeconds() + REMEMBERED_AUTH_TTL_SECONDS,
      redirect_host: redirectHost,
      passcode_hash: await sha256Base64Url(await currentOauthPasscode(env)),
      encrypted_esa_token: encryptedEsaToken,
    } satisfies RememberedAuthPayload,
    signingSecret,
  );
  return rememberedAuthCookie(value);
}

const AUTHORIZE_PRIVATE_FIELDS = new Set([
  "passcode",
  "esa_access_token",
  "github_token",
  "remember_browser",
  "use_remembered",
  "forget_remembered",
]);

function isAuthorizePrivateField(key: string) {
  return AUTHORIZE_PRIVATE_FIELDS.has(key) || key.endsWith("_api_key");
}

export function renderAuthorizeForm(
  params: URLSearchParams,
  error?: string,
  remembered = false,
  githubAppConfigured = false,
) {
  const hiddenInputs = [...params.entries()]
    .filter(([key]) => !isAuthorizePrivateField(key))
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join("\n");
  const errorHtml = error ? `<p class="error">${htmlEscape(error)}</p>` : "";
  const forgetParams = new URLSearchParams(params);
  for (const key of [...forgetParams.keys()]) {
    if (isAuthorizePrivateField(key)) {
      forgetParams.delete(key);
    }
  }
  forgetParams.set("forget_remembered", "1");
  const githubStatus = githubAppConfigured
    ? `<p class="notice">GitHub Appで実装同期が有効です。GitHub tokenの入力は不要です。</p>`
    : `<p class="muted">実装同期を使うには、対象repositoryだけにインストールしたGitHub AppをWorkerへ設定してください。</p>`;
  const formFields = remembered
    ? `<p>このブラウザに保存した認証情報を使います。値は表示されません。</p>
    <input type="hidden" name="use_remembered" value="1">
    <button type="submit">保存済み認証情報でAuthorize</button>
    <p><a href="/oauth/authorize?${htmlEscape(forgetParams.toString())}">保存を解除して入力し直す</a></p>`
    : `<label for="passcode">OAuth passcode</label>
    <input id="passcode" name="passcode" type="password" autocomplete="current-password" required>
    <label for="esa_access_token">esa access token</label>
    <input id="esa_access_token" name="esa_access_token" type="password" autocomplete="off" required>
    ${githubStatus}
    <label class="remember"><input name="remember_browser" type="checkbox" value="1">このブラウザで30日間、認証情報の再入力を省略する</label>
    <button type="submit">Authorize</button>`;

  return new Response(
    `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize esa MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
    label, input, button { display: block; width: 100%; box-sizing: border-box; }
    input { padding: .7rem; margin: .4rem 0 1rem; }
    button { padding: .7rem; }
    label.remember { display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 1rem; }
    label.remember input { width: auto; margin: .25rem 0 0; }
    .error { color: #b00020; }
    .notice { color: #126b37; }
    .muted { color: #52606d; }
  </style>
</head>
<body>
  <h1>Authorize esa MCP</h1>
  <p>MCPクライアントにesaへのアクセスを許可します。OAuth passcodeとesa tokenを入力してください。記事作成・更新も使う場合はwrite権限つきtokenが必要です。入力されたtokenはサーバーに保存しません。</p>
  ${errorHtml}
  <form method="post" action="/oauth/authorize">
    ${hiddenInputs}
    ${formFields}
  </form>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function oauthAuthorize(request: Request, env: Env) {
  const params = await requestParams(request);
  const responseType = params.get("response_type");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  const resource = canonicalResource(request, params.get("resource"));
  const scope = canonicalOAuthScope(params.get("scope") ?? OAUTH_SCOPE);

  if (
    responseType !== OAuthResponseType.Code ||
    !clientId ||
    !redirectUri ||
    !codeChallenge ||
    codeChallengeMethod !== PkceCodeChallengeMethod.S256
  ) {
    return oauthError(OAuthErrorCode.InvalidRequest);
  }

  if (!scope) {
    return oauthError(OAuthErrorCode.InvalidScope);
  }

  if (!resource) {
    return oauthError(OAuthErrorCode.InvalidTarget);
  }

  const redirectHost = validatedRedirectHost(redirectUri, env);
  if (!redirectHost) {
    return oauthError(OAuthErrorCode.InvalidRedirectUri);
  }

  let githubAppConfigured = false;
  try {
    githubAppConfigured = isGithubAppConfigured(env);
  } catch {
    return renderAuthorizeForm(
      params,
      "GitHub Appの設定が不足しています。App ID、installation ID、秘密鍵をすべて設定してください。",
    );
  }
  const authorizeForm = (error?: string, remembered = false) => renderAuthorizeForm(params, error, remembered, githubAppConfigured);

  const hasRememberedCookie = Boolean(readCookie(request, REMEMBERED_AUTH_COOKIE));
  if (params.get("forget_remembered") === "1") {
    params.delete("forget_remembered");
    return withCookie(authorizeForm(), clearRememberedAuthCookie());
  }

  const rememberedAuth = await readRememberedAuth(request, env, redirectHost);
  if (request.method !== HttpMethod.Post) {
    const response = authorizeForm(undefined, Boolean(rememberedAuth));
    return hasRememberedCookie && !rememberedAuth ? withCookie(response, clearRememberedAuthCookie()) : response;
  }

  const useRemembered = params.get("use_remembered") === "1";
  let esaAccessToken: string | undefined;

  if (useRemembered) {
    if (!rememberedAuth) {
      return withCookie(
        authorizeForm("保存済み認証情報を利用できません。もう一度入力してください。"),
        clearRememberedAuthCookie(),
      );
    }
    esaAccessToken = rememberedAuth.esaAccessToken;
  } else {
    const passcode = params.get("passcode");
    esaAccessToken = params.get("esa_access_token")?.trim();

    if (!passcode || !timingSafeEqual(passcode, await currentOauthPasscode(env))) {
      await writeAudit(env, request, AuditEventType.OauthAuthorizeFailed);
      return authorizeForm("Passcodeが違います。");
    }
    if (!esaAccessToken) {
      return authorizeForm("esa access tokenを入力してください。");
    }
  }

  const signingSecret = await currentSigningSecret(env);
  let tokenInfo: EsaTokenInfo;
  try {
    tokenInfo = await validateEsaReadAccess(esaAccessToken, env);
  } catch {
    await writeAudit(env, request, AuditEventType.EsaTokenValidationFailed, { client_id: clientId });
    const response = authorizeForm(`esa access tokenで${describeEsaValidationTarget(env)}を読めませんでした。tokenの権限とチームを確認してください。`);
    return useRemembered ? withCookie(response, clearRememberedAuthCookie()) : response;
  }
  const esaUserId = tokenInfo.resource_owner_id ?? tokenInfo.user?.id ?? tokenInfo.id;
  const esaTokenScope = normalizeScope(tokenInfo.scope);
  const encryptedEsaToken = await encryptText(esaAccessToken, signingSecret);
  const connectionId = crypto.randomUUID();

  const code = await createSignedValue(
    {
      kind: SignedPayloadKind.AuthorizationCode,
      code_id: crypto.randomUUID(),
      exp: nowSeconds() + AUTH_CODE_TTL_SECONDS,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      resource,
      scope,
      encrypted_esa_token: encryptedEsaToken,
      connection_id: connectionId,
      esa_user_id: esaUserId,
      esa_token_scope: esaTokenScope,
    } satisfies AuthCodePayload,
    signingSecret,
  );
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  const response = Response.redirect(redirectUrl.toString(), 302);
  if (useRemembered || params.get("remember_browser") === "1") {
    return withCookie(
      response,
      await createRememberedAuthCookie(env, redirectHost, encryptedEsaToken),
    );
  }
  return response;
}

export async function sha256Base64Url(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(hash));
}

export async function oauthRegister(request: Request, env: Env) {
  if (request.method !== HttpMethod.Post) {
    return oauthError(OAuthErrorCode.MethodNotAllowed, HttpStatusCode.MethodNotAllowed);
  }

  const metadata = (await request.json().catch(() => ({}))) as { redirect_uris?: unknown; scope?: unknown };
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((value): value is string => typeof value === "string")
    : [];
  const scope = canonicalOAuthScope(typeof metadata.scope === "string" ? metadata.scope : OAUTH_SCOPE);
  if (redirectUris.length === 0 || redirectUris.some((redirectUri) => !validatedRedirectHost(redirectUri, env))) {
    return oauthError(OAuthErrorCode.InvalidRedirectUri);
  }
  if (!scope) {
    return oauthError(OAuthErrorCode.InvalidScope);
  }

  return jsonResponse(
    {
      client_id: `mcp-client-${crypto.randomUUID()}`,
      client_id_issued_at: nowSeconds(),
      redirect_uris: redirectUris,
      grant_types: [OAuthGrantType.AuthorizationCode],
      response_types: [OAuthResponseType.Code],
      token_endpoint_auth_method: OAuthClientAuthMethod.None,
      scope,
    },
    { status: HttpStatusCode.Created },
  );
}

function scheduleOauthTracking(ctx: ExecutionContext | undefined, task: Promise<unknown>) {
  const handledTask = task.catch((error) => {
    console.warn("oauth tracking skipped", error instanceof Error ? error.name : typeof error);
  });
  if (ctx) {
    ctx.waitUntil(handledTask);
    return;
  }
  return handledTask;
}

async function consumeAuthorizationCode(env: Env, codeId: string, expiresAt: number) {
  if (!env.OAUTH_CODE_DB) {
    throw new Error("OAUTH_CODE_DB is not configured.");
  }
  return consumeOAuthAuthorizationCode(env.OAUTH_CODE_DB, codeId, expiresAt);
}

export async function oauthToken(request: Request, env: Env, ctx?: ExecutionContext) {
  if (request.method !== HttpMethod.Post) {
    return oauthError(OAuthErrorCode.MethodNotAllowed, HttpStatusCode.MethodNotAllowed);
  }

  const params = new URLSearchParams(await request.text());
  const grantType = params.get("grant_type");
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const codeVerifier = params.get("code_verifier");
  const resource = canonicalResource(request, params.get("resource"));

  if (
    !resource ||
    grantType !== OAuthGrantType.AuthorizationCode ||
    !code ||
    !redirectUri ||
    !clientId ||
    !codeVerifier ||
    !validatedRedirectHost(redirectUri, env)
  ) {
    return oauthError(OAuthErrorCode.InvalidRequest);
  }

  const signingSecret = await currentSigningSecret(env);
  const authCode = await verifySignedValue<AuthCodePayload>(code, signingSecret);
  if (
    authCode?.kind !== SignedPayloadKind.AuthorizationCode ||
    !authCode.code_id ||
    authCode.exp < nowSeconds() ||
    authCode.client_id !== clientId ||
    authCode.redirect_uri !== redirectUri ||
    authCode.resource !== resource ||
    !authCode.encrypted_esa_token ||
    !authCode.connection_id
  ) {
    return oauthError(OAuthErrorCode.InvalidGrant);
  }

  const expectedChallenge = await sha256Base64Url(codeVerifier);
  if (!timingSafeEqual(expectedChallenge, authCode.code_challenge)) {
    return oauthError(OAuthErrorCode.InvalidGrant);
  }

  let codeConsumed: boolean;
  try {
    codeConsumed = await consumeAuthorizationCode(env, authCode.code_id, authCode.exp);
  } catch {
    return oauthError(OAuthErrorCode.ServerError, HttpStatusCode.ServiceUnavailable);
  }
  if (!codeConsumed) {
    return oauthError(OAuthErrorCode.InvalidGrant);
  }

  const accessToken = await createSignedValue(
    {
      kind: SignedPayloadKind.AccessToken,
      exp: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS,
      aud: resource,
      scope: authCode.scope,
      client_id: clientId,
      encrypted_esa_token: authCode.encrypted_esa_token,
      connection_id: authCode.connection_id,
      esa_user_id: authCode.esa_user_id,
      esa_token_scope: authCode.esa_token_scope,
    } satisfies AccessTokenPayload,
    signingSecret,
  );

  const redirectHost = safeHost(redirectUri);
  const esaTokenScope = normalizeScope(authCode.esa_token_scope)?.join(" ");

  await scheduleOauthTracking(
    ctx,
    Promise.all([
      writeAudit(env, request, AuditEventType.OauthConnected, {
        connection_id: authCode.connection_id,
        client_id: clientId,
        redirect_host: redirectHost,
        scope: authCode.scope,
        esa_user_id: authCode.esa_user_id,
        esa_token_scope: esaTokenScope,
      }),
      writeConnection(env, request, {
        id: authCode.connection_id,
        connected_at: new Date().toISOString(),
        expires_at: new Date((nowSeconds() + ACCESS_TOKEN_TTL_SECONDS) * 1000).toISOString(),
        client_id: clientId,
        redirect_host: redirectHost,
        scope: authCode.scope,
        esa_user_id: authCode.esa_user_id,
        esa_token_scope: esaTokenScope,
        github_connected: isGithubAppConfigured(env),
      }),
    ]),
  );

  return jsonResponse({
    access_token: accessToken,
    token_type: OAuthTokenType.Bearer,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: authCode.scope,
  });
}
