#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === ".git" ||
      entry.name === ".worktrees" ||
      entry.name === ".claude" ||
      entry.name === "node_modules" ||
      entry.name === "release-stage" ||
      entry.name === "dist" ||
      entry.name === "out"
    ) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.name === "package.json") {
      yield path;
    }
  }
}

const failures = [];
for (const packagePath of walk(repoRoot)) {
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
  process.exit(1);
}

console.log("package license check passed");
