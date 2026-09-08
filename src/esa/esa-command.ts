import { ModelReadMode } from "../core/constants";
import { DomainStatus, inputError } from "../core/errors";
import { esaGet, firstPostNumber } from "./esa-api";
import { getPostCollection, getPostModelView, searchPostsLightweight } from "./esa-read";

const POST_COMMANDS = [
  { prefixes: ["comments", "comment", "c "], kind: "collection", collection: "comments" },
  { prefixes: ["backlinks", "backlink", "b "], kind: "collection", collection: "backlinks" },
  { prefixes: ["outline", "toc "], kind: "view", mode: ModelReadMode.Outline },
  { prefixes: ["compact"], kind: "view", mode: ModelReadMode.Metadata },
] as const;

export async function runEsaCommand(command: string, teamName: string, token: string) {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();

  if (!trimmed || normalized === "help") {
    return {
      usage: [
        "#123",
        "post 123",
        "comments 123",
        "backlinks 123",
        "search keyword",
        "outline 123",
        "compact 123",
        "tags",
        "categories",
      ],
    };
  }

  if (normalized === "tags" || normalized === "tag") {
    return esaGet({ teamName, path: "/tags", token });
  }

  if (normalized === "categories" || normalized === "category" || normalized === "cats") {
    return esaGet({ teamName, path: "/categories", token });
  }

  if (normalized.startsWith("search ") || normalized.startsWith("s ")) {
    const q = trimmed.replace(/^(search|s)\s+/i, "").trim();
    if (!q) {
      throw inputError("Search command requires a query, for example `search in:help onboarding`.", "Pass a search query after search or s.", DomainStatus.SearchQueryRequired);
    }
    return searchPostsLightweight({ teamName, token, q, perPage: 20 });
  }

  const postNumber = firstPostNumber(trimmed);
  if (!postNumber) {
    throw inputError("Could not find a post number. Try `#123`, `post 123`, `comments 123`, or `search keyword`.", "Pass a post number or search command.", DomainStatus.CommandTargetNotFound);
  }

  const matched = POST_COMMANDS.find(({ prefixes }) => prefixes.some((prefix) => normalized.startsWith(prefix)));
  if (matched?.kind === "collection") {
    return getPostCollection({ teamName, token, postNumber, collection: matched.collection });
  }

  return getPostModelView({
    teamName,
    token,
    postNumber,
    mode: matched?.kind === "view" ? matched.mode : ModelReadMode.Markdown,
  });
}
