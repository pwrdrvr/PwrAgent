#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// pnpm reports physical paths. Resolve aliases here too, including Windows
// short directory names, before deduplicating roots or formatting diagnostics.
const repoRoot = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function firstPartyPackagePaths() {
  // pnpm owns membership through pnpm-workspace.yaml. Depth -1 lists only
  // workspace projects, never their dependencies or nested cache manifests.
  const execPath = process.env.npm_execpath;
  const pnpm = execPath && basename(execPath).startsWith("pnpm") ? execPath : "pnpm";
  const args = ["--recursive", "list", "--depth", "-1", "--json"];
  const isNodeScript = /\.[cm]?js$/.test(pnpm);
  const result = spawnSync(
    isNodeScript ? process.execPath : pnpm,
    isNodeScript ? [pnpm, ...args] : args,
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32" && (pnpm === "pnpm" || pnpm.endsWith(".cmd")),
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || "pnpm workspace listing failed");
  }
  const projects = JSON.parse(result.stdout);
  if (!Array.isArray(projects)) {
    throw new Error("pnpm workspace listing must be an array");
  }
  // The root is first-party even when recursiveIncludeWorkspaceRoot is false.
  return [...new Set([
    join(repoRoot, "package.json"),
    ...projects.map((project) => join(project.path, "package.json")),
  ])].sort();
}

function main() {
  const failures = [];
  for (const packagePath of firstPartyPackagePaths()) {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    if (packageJson.license !== "MIT") {
      failures.push(
        `${relative(repoRoot, packagePath)} declares license ${JSON.stringify(
          packageJson.license,
        )}; expected "MIT"`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("package license check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("package license check passed");
}

try {
  main();
} catch (error) {
  console.error(`package license check failed: ${error.message}`);
  process.exitCode = 1;
}
