import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, ".test-output");
const outputFile = path.join(outputDirectory, "esa.test.mjs");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

try {
  await build({
    entryPoints: [path.join(projectRoot, "tests", "esa.test.mjs")],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["yaml"],
    sourcemap: "inline",
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outputFile], { cwd: projectRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
