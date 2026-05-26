#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackagePath = resolve(repoRoot, "apps/desktop/package.json");
const electronBuilderPath = resolve(repoRoot, "apps/desktop/electron-builder.yml");
const releaseScriptPath = resolve(repoRoot, "apps/desktop/scripts/release.mjs");
const releaseWorkflowPath = resolve(repoRoot, ".github/workflows/release.yml");
const desktopReleaseRunbookPath = resolve(repoRoot, "docs/desktop-release-runbook.md");
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
if (desktopPackage.homepage !== "https://pwragent.ai") {
  fail("apps/desktop/package.json must contain homepage metadata for Linux DEB packaging");
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

const electronBuilderConfig = readFileSync(electronBuilderPath, "utf8");
const releaseScript = readFileSync(releaseScriptPath, "utf8");
const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
const desktopReleaseRunbook = readFileSync(desktopReleaseRunbookPath, "utf8");

const desktopScripts = desktopPackage.scripts || {};
if (desktopScripts["package:linux"] !== "node ./scripts/release.mjs --linux --no-publish") {
  fail("apps/desktop/package.json must expose package:linux for local Linux package builds");
}
if (desktopScripts["release:linux"] !== "node ./scripts/release.mjs --linux") {
  fail("apps/desktop/package.json must expose release:linux for local Linux package publishing");
}

for (const expected of [
  "linux:",
  "executableName: pwragent",
  "target: deb",
  "arch: [x64, arm64]",
  "artifactName: \"${productName}-${version}-linux-${arch}.${ext}\"",
  "desktop:",
  "entry:",
  "StartupWMClass: PwrAgent",
  "private: false",
]) {
  if (!electronBuilderConfig.includes(expected)) {
    fail(`apps/desktop/electron-builder.yml must contain ${JSON.stringify(expected)}`);
  }
}

for (const invalid of [/^    Name:/m, /^    Comment:/m, /^    StartupWMClass:/m]) {
  if (invalid.test(electronBuilderConfig)) {
    fail(
      `apps/desktop/electron-builder.yml must nest Linux desktop entries under desktop.entry; matched ${invalid}`,
    );
  }
}

for (const expected of [
  "-linux-amd64.deb",
  "PwrAgent-linux-x64.deb",
  "PwrAgent-linux-arm64.deb",
  "patchStageDependencyManifests",
  "@larksuiteoapi+node-sdk@1.63.1",
]) {
  if (!releaseScript.includes(expected)) {
    fail(`apps/desktop/scripts/release.mjs must contain ${JSON.stringify(expected)}`);
  }
}

for (const expected of [
  "ubuntu-24.04-arm",
  "Package Linux DEB",
  "Publish Linux DEB artifacts",
  "PWRAGENT_LINUX_ARCH",
  "SHA256SUMS",
]) {
  if (!releaseWorkflow.includes(expected)) {
    fail(`.github/workflows/release.yml must contain ${JSON.stringify(expected)}`);
  }
}

for (const expected of [
  "PwrAgent-linux-x64.deb",
  "PwrAgent-linux-arm64.deb",
  "SHA256SUMS",
]) {
  if (!desktopReleaseRunbook.includes(expected)) {
    fail(`docs/desktop-release-runbook.md must contain ${JSON.stringify(expected)}`);
  }
}

if (process.exitCode) {
  process.exit();
}

console.log(`release metadata check passed for ${tag}`);
