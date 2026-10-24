import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function runOxlint(config, paths) {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("oxlint/package.json");
  const { bin } = JSON.parse(readFileSync(packageFile, "utf8"));
  const result = spawnSync(process.execPath, [
    resolve(dirname(packageFile), bin.oxlint), "--config", config, ...paths,
  ], { cwd: repositoryRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
