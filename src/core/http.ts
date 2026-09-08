import {
  HttpMethod,
  HttpStatusCode,
  MCP_ENDPOINT_PATHS,
  OAUTH_SCOPES,
  OAuthErrorCode,
  OAuthTokenType,
  PROTECTED_RESOURCE_METADATA_PATH,
  RUNTIME_VERSION_HEADER,
} from "./constants";
import { DomainStatus, ErrorSource, normalizeToolError, type ToolErrorPayload } from "./errors";

export function requestOrigin(request: Request) {
  return new URL(request.url).origin;
}

export function withRuntimeVersion(response: Response, versionId: string | undefined) {
  if (!versionId) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(RUNTIME_VERSION_HEADER, versionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function oauthMetadataUrl(request: Request) {
  const url = new URL(request.url);
  const endpointPath = MCP_ENDPOINT_PATHS.includes(url.pathname) ? url.pathname : "";
  return `${url.origin}${PROTECTED_RESOURCE_METADATA_PATH}${endpointPath}`;
}

export function unauthorizedResponse(
  request: Request,
  message = "Unauthorized",
  requiredScopes: readonly string[] = OAUTH_SCOPES,
) {
  return Response.json(
    { error: OAuthErrorCode.InvalidToken, error_description: message },
    {
      status: HttpStatusCode.Unauthorized,
      headers: {
        "WWW-Authenticate": `${OAuthTokenType.Bearer} error="${OAuthErrorCode.InvalidToken}", resource_metadata="${oauthMetadataUrl(request)}", scope="${requiredScopes.join(" ")}"`,
      },
    },
  );
}

export function insufficientScopeResponse(request: Request, requiredScopes: readonly string[]) {
  return Response.json(
    {
      error: OAuthErrorCode.InsufficientScope,
      error_description: "The access token does not include the scopes required by this MCP endpoint.",
    },
    {
      status: HttpStatusCode.Forbidden,
      headers: {
        "WWW-Authenticate": `${OAuthTokenType.Bearer} error="${OAuthErrorCode.InsufficientScope}", scope="${requiredScopes.join(" ")}", resource_metadata="${oauthMetadataUrl(request)}"`,
      },
    },
  );
}

export function jsonResponse(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

export function errorResponse(error: unknown, request: Request) {
  const payload = normalizeToolError(error);
  const status = httpStatusForError(payload);
  const body = {
    ok: false,
    error: payload,
  };

  if (wantsHtmlError(request)) {
    return htmlResponse(renderErrorHtml(payload, status), { status });
  }

  return jsonResponse(body, { status });
}

function httpStatusForError(error: ToolErrorPayload) {
  if (error.http_status && error.http_status >= 400 && error.http_status <= 599) {
    return error.http_status;
  }
  if (isClientError(error.source, error.domain_status)) {
    return HttpStatusCode.BadRequest;
  }
  return HttpStatusCode.InternalServerError;
}

function isClientError(source: ErrorSource, domainStatus: DomainStatus) {
  switch (source) {
    case ErrorSource.Input:
    case ErrorSource.WriteConfirmation:
      return true;
    default:
      break;
  }

  switch (domainStatus) {
    case DomainStatus.TeamRequired:
    case DomainStatus.ObserverRequired:
    case DomainStatus.InvalidInput:
      return true;
    default:
      return false;
  }
}

function wantsHtmlError(request: Request) {
  const url = new URL(request.url);
  const accept = request.headers.get("Accept") ?? "";
  return url.pathname.startsWith("/admin") || (accept.includes("text/html") && !url.pathname.startsWith("/mcp") && !url.pathname.startsWith("/oauth/token"));
}

function renderErrorHtml(error: ToolErrorPayload, status: number) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>esa MCP Error</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.55; color: #172026; }
    code { background: #eef2f4; padding: .12rem .3rem; border-radius: 4px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem .8rem; }
    dt { font-weight: 700; }
    dd { margin: 0; }
    .hint { background: #fff7df; border: 1px solid #efd48a; padding: .75rem; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>esa MCP Error</h1>
  <p>${htmlEscape(error.message_ja)}</p>
  ${error.hint_ja ? `<p class="hint">${htmlEscape(error.hint_ja)}</p>` : ""}
  <dl>
    <dt>HTTP</dt><dd><code>${htmlEscape(String(status))}</code></dd>
    <dt>domain_status</dt><dd><code>${htmlEscape(error.domain_status)}</code></dd>
    <dt>source</dt><dd><code>${htmlEscape(error.source)}</code></dd>
    <dt>message</dt><dd><code>${htmlEscape(error.message.slice(0, 240))}</code></dd>
  </dl>
</body>
</html>`;
}

export function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) {
      return valueParts.join("=");
    }
  }
  return undefined;
}

export function htmlResponse(html: string, init?: ResponseInit) {
  return new Response(html, {
    ...init,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

export async function requestParams(request: Request) {
  if (request.method === HttpMethod.Post) {
    return new URLSearchParams(await request.text());
  }
  return new URL(request.url).searchParams;
}
