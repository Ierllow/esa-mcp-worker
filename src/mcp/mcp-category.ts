import { z } from "zod";
import { createTextResult, createWriteResult } from "../core/utils";
import { batchMoveCategory, esaGet } from "../esa/esa";
import {
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  OPTIONAL_TEAM_NAME_SCHEMA,
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_META,
} from "./mcp-static";
import type { McpRegistration } from "./mcp-registration";

export function registerCategoryTools({ esaTool, token }: McpRegistration) {
  const readToolAnnotations = READ_TOOL_ANNOTATIONS;
  const destructiveWriteToolAnnotations = DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS;
  const writeToolMeta = WRITE_TOOL_META;
  esaTool(
    "esa_get_categories",
    {
      title: "Get esa Categories",
      annotations: readToolAnnotations,
      description: "Fetch category stats for an esa team.",
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
      }),
    },
    () => ({ target: "categories" }),
    async (_args, teamName) => {
      const categories = await esaGet({
        teamName,
        path: "/categories",
        token,
      });
      return createTextResult(categories);
    },
  );

  esaTool(
    "esa_batch_move_category",
    {
      title: "Batch Move esa Category",
      annotations: destructiveWriteToolAnnotations,
      description:
        "Move an esa category and all descendant categories to another category path. This can affect many posts. Requires write scope and confirm_write=true. A completed result needs no follow-up read.",
      _meta: writeToolMeta,
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
        from: z.string().min(1).describe("Source category path, for example /foo/bar/."),
        to: z.string().min(1).describe("Destination category path, for example /baz/."),
        confirm_write: z.boolean().describe("Must be true to move the category tree."),
      }),
    },
    () => ({ target: "category:batch_move" }),
    async ({ from, to }, teamName) => {
      const result = await batchMoveCategory({ teamName, token, from, to });
      return createWriteResult("category_moved", result);
    },
  );

  esaTool(
    "esa_get_tags",
    {
      title: "Get esa Tags",
      annotations: readToolAnnotations,
      description: "Fetch tags for an esa team.",
      inputSchema: z.object({
        team_name: OPTIONAL_TEAM_NAME_SCHEMA,
      }),
    },
    () => ({ target: "tags" }),
    async (_args, teamName) => {
      const tags = await esaGet({
        teamName,
        path: "/tags",
        token,
      });
      return createTextResult(tags);
    },
  );
}
