import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const domainDirectories = new Set(["esa", "github", "mcp"]);
const errors = [];

async function checkDirectory(directory, parts = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativeParts = [...parts, entry.name];
    const relativePath = relativeParts.join("/");
    if (entry.isDirectory()) {
      await checkDirectory(path.join(directory, entry.name), relativeParts);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.ts$/.test(entry.name)) {
      errors.push(`${relativePath}: use a kebab-case TypeScript filename`);
    }
    const domain = relativeParts[0];
    if (domainDirectories.has(domain) && entry.name !== `${domain}.ts` && !entry.name.startsWith(`${domain}-`)) {
      errors.push(`${relativePath}: use the ${domain}-<role>.ts naming pattern`);
    }
  }
}

await checkDirectory(sourceRoot);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("TypeScript filenames follow repository conventions.");
}
