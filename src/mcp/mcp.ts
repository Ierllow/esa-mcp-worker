import { McpServer } from "@modelcontextprotocol/server";
import { McpProfile } from "../core/constants";
import type { AccessTokenPayload, Env } from "../core/types";
import { registerGithubTools } from "../github/github-mcp";
import { registerCategoryTools } from "./mcp-category";
import { createMcpRegistration } from "./mcp-registration";
import { registerCommandTool, registerCommonReadTools, registerContextEntryTool, registerFullReadTools } from "./mcp-read";
import { FAST_INSTRUCTIONS, FULL_INSTRUCTIONS, SERVER_INFO } from "./mcp-static";
import { registerWriteTools } from "./mcp-write";

export function createServer(
  env: Env,
  token: string,
  request: Request,
  ctx: ExecutionContext,
  payload?: AccessTokenPayload,
  profile: McpProfile = McpProfile.Full,
) {
  const server = new McpServer(SERVER_INFO, {
    instructions: profile === McpProfile.Fast ? FAST_INSTRUCTIONS : FULL_INSTRUCTIONS,
  });
  const registration = createMcpRegistration(server, env, token, request, ctx, payload);

  if (profile === McpProfile.Full) {
    registerGithubTools({ server, env, track: registration.track });
  }

  registerContextEntryTool(registration);
  if (profile === McpProfile.Full) {
    registerCommandTool(registration);
  }
  registerCommonReadTools(registration, profile);
  if (profile === McpProfile.Full) {
    registerFullReadTools(registration);
    registerCategoryTools(registration);
    registerWriteTools(registration);
  }

  return server;
}
