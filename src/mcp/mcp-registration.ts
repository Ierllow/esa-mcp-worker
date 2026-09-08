import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withToolTracking } from "../core/audit";
import type { AccessTokenPayload, AuditEvent, Env } from "../core/types";
import { resolveTeamName, requireWriteConfirmation } from "../esa/esa";
import { syncObservedPostBaselines, type ObservedPostState } from "../state/context-observer";
import { READ_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from "./mcp-static";

export function createMcpRegistration(
  server: McpServer,
  env: Env,
  token: string,
  request: Request,
  ctx: ExecutionContext,
  payload?: AccessTokenPayload,
) {
  const registerTool = server.registerTool.bind(server);
  const track = <T>(toolName: string, details: Partial<AuditEvent>, run: () => Promise<T>) =>
    withToolTracking(env, request, payload, ctx, toolName, details, run);
  const esaTool = <S extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    config: {
      title: string;
      description: string;
      annotations: typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;
      _meta?: Record<string, string>;
      inputSchema: S;
    },
    details: (args: z.infer<S>) => Partial<AuditEvent>,
    run: (args: z.infer<S>, teamName: string) => Promise<unknown>,
  ) =>
    registerTool(name, config, ((args: z.infer<S>) =>
      track(name, details(args), async () => {
        const confirmWrite = (args as { confirm_write?: boolean }).confirm_write;
        if (confirmWrite !== undefined) {
          requireWriteConfirmation(confirmWrite);
        }
        return run(args, resolveTeamName((args as { team_name?: string }).team_name, env));
      })) as never);
  const syncObserver = (teamName: string, values: unknown[]) => {
    const states = values.flatMap((value): ObservedPostState[] => {
      if (!value || typeof value !== "object") {
        return [];
      }
      const post = value as Record<string, unknown>;
      if (!Number.isInteger(post.number) || Number(post.number) <= 0) {
        return [];
      }
      return [{
        post_number: Number(post.number),
        title: typeof post.title === "string" ? post.title : undefined,
        updated_at: typeof post.updated_at === "string" ? post.updated_at : undefined,
        revision_number: typeof post.revision_number === "number" ? post.revision_number : undefined,
        context_version: typeof post.context_version === "string" ? post.context_version : undefined,
      }];
    });
    if (states.length === 0) {
      return;
    }
    ctx.waitUntil(
      syncObservedPostBaselines(env, teamName, states).catch((error) => {
        console.warn("context observer sync skipped", error instanceof Error ? error.name : typeof error);
      }),
    );
  };

  return { env, token, registerTool, esaTool, track, syncObserver };
}

export type McpRegistration = ReturnType<typeof createMcpRegistration>;
