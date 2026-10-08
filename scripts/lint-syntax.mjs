import { globSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot, runOxlint } from "./oxlint.mjs";

export function syntaxLintPaths(directory = repositoryRoot) {
  // cmd.exe does not expand *.ts. Expand root files here so Windows checks the
  // same configs as macOS/Linux; directory walking is handled by Oxlint.
  return ["packages", "apps", ...globSync("*.ts", { cwd: directory })];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runOxlint(".oxlintrc.json", syntaxLintPaths());
}
