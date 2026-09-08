import { createMcpHandler } from "agents/mcp/server";
import { handleAdmin } from "./admin/admin";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  HttpStatusCode,
  MCP_PROFILE_BY_PATH,
  MCP_PROFILE_REQUIRED_SCOPES,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "./core/constants";
import { createServer } from "./mcp/mcp";
import { authenticateMcpRequest, oauthAuthorizationServerMetadata, oauthAuthorize, oauthRegister, oauthToken, protectedResourceMetadata } from "./auth/oauth";
import { errorResponse, withRuntimeVersion } from "./core/http";
import type { Env } from "./core/types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    let response: Response;
    try {
      response = await handleRequest(request, env, ctx);
    } catch (error) {
      console.error("Unhandled Worker error", error instanceof Error ? error.name : typeof error);
      response = errorResponse(error, request);
    }
    return withRuntimeVersion(response, env.CF_VERSION_METADATA?.id);
  },
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    return Response.json({
      name: "esa-mcp-worker",
      status: "ok",
      mcp_endpoint: "/mcp",
      fast_mcp_endpoint: "/mcp-fast",
      auth: "oauth",
      admin: "/admin",
    });
  }

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return handleAdmin(request, env);
  }

  if (matchesPathPrefix(url.pathname, PROTECTED_RESOURCE_METADATA_PATH)) {
    return protectedResourceMetadata(request);
  }

  if (matchesPathPrefix(url.pathname, AUTHORIZATION_SERVER_METADATA_PATH)) {
    return oauthAuthorizationServerMetadata(request);
  }

  if (url.pathname === "/oauth/authorize") {
    return oauthAuthorize(request, env);
  }

  if (url.pathname === "/oauth/register") {
    return oauthRegister(request, env);
  }

  if (url.pathname === "/oauth/token") {
    return oauthToken(request, env, ctx);
  }

  const profile = MCP_PROFILE_BY_PATH[url.pathname];
  if (!profile) {
    return Response.json({ error: "not_found" }, { status: HttpStatusCode.NotFound });
  }

  const authResult = await authenticateMcpRequest(request, env, MCP_PROFILE_REQUIRED_SCOPES[profile]);
  if (authResult instanceof Response) {
    return authResult;
  }

  const mcpHandler = createMcpHandler(() =>
    createServer(
      env,
      authResult.esaToken,
      request,
      ctx,
      authResult.payload,
      profile,
    ),
    { route: url.pathname },
  );
  return mcpHandler(request, env, ctx);
}

function matchesPathPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
