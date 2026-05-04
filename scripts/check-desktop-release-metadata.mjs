#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackagePath = resolve(repoRoot, "apps/desktop/package.json");
const changelogPath = resolve(repoRoot, "CHANGELOG.md");

function usage() {
  console.error("Usage: RELEASE_TAG=v1.0.0-alpha.4 pnpm release:check");
  console.error("   or: pnpm release:check --tag v1.0.0-alpha.4");
}

function parseTagArg(argv) {
  const tagIndex = argv.indexOf("--tag");
  if (tagIndex !== -1) {
    return argv[tagIndex + 1];
  }
  const inline = argv.find((arg) => arg.startsWith("--tag="));
  if (inline) {
    return inline.slice("--tag=".length);
  }
  return process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
}

function fail(message) {
  console.error(`release metadata check failed: ${message}`);
  process.exitCode = 1;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const tag = parseTagArg(process.argv.slice(2));
if (!tag) {
  usage();
  fail("no release tag was provided");
  process.exit();
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`tag "${tag}" must look like vX.Y.Z or vX.Y.Z-prerelease`);
}

const expectedVersion = tag.slice(1);
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
if (desktopPackage.version !== expectedVersion) {
  fail(
    `apps/desktop/package.json version is ${desktopPackage.version}, but release tag ${tag} requires ${expectedVersion}`,
  );
}

let changelog = "";
try {
  changelog = readFileSync(changelogPath, "utf8");
} catch (error) {
  if (error && error.code === "ENOENT") {
    fail("CHANGELOG.md is missing");
  } else {
    throw error;
  }
}

const headingPattern = new RegExp(`^##\\s+v?${escapeRegex(expectedVersion)}(?:\\s|$)`, "m");
if (!headingPattern.test(changelog)) {
  fail(`CHANGELOG.md must contain a second-level heading for ${tag}`);
}

if (process.exitCode) {
  process.exit();
}

console.log(`release metadata check passed for ${tag}`);
