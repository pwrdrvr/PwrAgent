#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackagePath = resolve(repoRoot, "apps/desktop/package.json");
const electronBuilderPath = resolve(repoRoot, "apps/desktop/electron-builder.yml");
const ciWorkflowPath = resolve(repoRoot, ".github/workflows/ci.yml");
const releaseScriptPath = resolve(repoRoot, "apps/desktop/scripts/release.mjs");
const verifyAsarContentsPath = resolve(
  repoRoot,
  "apps/desktop/scripts/verify-asar-contents.mjs",
);
const releaseWorkflowPath = resolve(repoRoot, ".github/workflows/release.yml");
const trustedSigningSetupPath = resolve(
  repoRoot,
  "scripts/release/install-trusted-signing.ps1",
);
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

function workflowJobBody(workflow, workflowPath, jobName) {
  const jobPattern = new RegExp(`^  ${escapeRegex(jobName)}:\\n`, "m");
  const match = workflow.match(jobPattern);
  if (!match) {
    fail(`${workflowPath} must contain a ${jobName} job`);
    return "";
  }
  const bodyStart = match.index + match[0].length;
  const remainder = workflow.slice(bodyStart);
  const nextJobOffset = remainder.search(/^  [A-Za-z0-9_-]+:/m);
  return nextJobOffset === -1
    ? remainder
    : remainder.slice(0, nextJobOffset);
}

function assertWorkflowJobRunner(workflow, workflowPath, jobName, expectedRunner) {
  const jobBody = workflowJobBody(workflow, workflowPath, jobName);
  const runnerPattern = new RegExp(
    `^    runs-on:\\s+${escapeRegex(expectedRunner)}\\s*$`,
    "m",
  );
  if (!runnerPattern.test(jobBody)) {
    fail(`${workflowPath} ${jobName} must run on ${expectedRunner}`);
  }
}

function assertWorkflowJobOrdersText(
  workflow,
  workflowPath,
  jobName,
  first,
  second,
) {
  const jobBody = workflowJobBody(workflow, workflowPath, jobName);
  const firstIndex = jobBody.indexOf(first);
  const secondIndex = jobBody.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    fail(
      `${workflowPath} ${jobName} must place ${JSON.stringify(first)} before ${JSON.stringify(second)}`,
    );
  }
}

function assertWorkflowStepContinuesOnError(workflow, workflowPath, stepName) {
  const stepPattern = new RegExp(`^      - name: ${escapeRegex(stepName)}\\n`, "m");
  const match = workflow.match(stepPattern);
  if (!match) {
    fail(`${workflowPath} must contain a ${stepName} step`);
    return;
  }
  const bodyStart = match.index + match[0].length;
  const remainder = workflow.slice(bodyStart);
  const nextStepOffset = remainder.search(/^      - name:/m);
  const stepBody = nextStepOffset === -1
    ? remainder
    : remainder.slice(0, nextStepOffset);
  if (!/^        continue-on-error:\s+true\s*$/m.test(stepBody)) {
    fail(`${workflowPath} ${stepName} must use continue-on-error: true`);
  }
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
const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");
const releaseScript = readFileSync(releaseScriptPath, "utf8");
const verifyAsarContents = readFileSync(verifyAsarContentsPath, "utf8");
const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
const trustedSigningSetup = readFileSync(trustedSigningSetupPath, "utf8");
const desktopReleaseRunbook = readFileSync(desktopReleaseRunbookPath, "utf8");

const desktopScripts = desktopPackage.scripts || {};
if (
  desktopPackage.optionalDependencies?.["@napi-rs/canvas-win32-x64-msvc"]
  !== desktopPackage.dependencies?.["@napi-rs/canvas"]
) {
  fail(
    "apps/desktop/package.json must keep matching @napi-rs/canvas and Windows x64 binding versions",
  );
}
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
  "node_modules/@napi-rs/canvas-win32-x64-msvc/**/*",
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
  "configureStageGithubReleaseType",
  "configured GitHub releaseType=${releaseType}",
  "^@larksuiteoapi\\+node-sdk@",
  "deployedAxios",
]) {
  if (!releaseScript.includes(expected)) {
    fail(`apps/desktop/scripts/release.mjs must contain ${JSON.stringify(expected)}`);
  }
}

for (const expected of [
  "requiredPackagedRuntimeFiles",
  "unpackedPath",
  "required packaged runtime files are missing",
]) {
  if (!verifyAsarContents.includes(expected)) {
    fail(
      `apps/desktop/scripts/verify-asar-contents.mjs must contain ${JSON.stringify(expected)}`,
    );
  }
}

for (const expected of [
  "releases/**",
  "ci:windows-signing",
  "github.event.pull_request.head.repo.full_name == github.repository",
  "environment: windows-signing",
  "scripts/release/install-trusted-signing.ps1",
  "--win --no-publish --require-signing",
]) {
  if (!ciWorkflow.includes(expected)) {
    fail(`.github/workflows/ci.yml must contain ${JSON.stringify(expected)}`);
  }
}
assertWorkflowJobRunner(
  ciWorkflow,
  ".github/workflows/ci.yml",
  "windows-package",
  "windows-2022",
);
assertWorkflowJobRunner(
  ciWorkflow,
  ".github/workflows/ci.yml",
  "windows-signing-preflight",
  "windows-2022",
);
assertWorkflowJobRunner(
  ciWorkflow,
  ".github/workflows/ci.yml",
  "windows-signing",
  "windows-2022",
);
assertWorkflowJobOrdersText(
  ciWorkflow,
  ".github/workflows/ci.yml",
  "windows-signing",
  "scripts/release/install-trusted-signing.ps1",
  "--win --no-publish --require-signing",
);

for (const expected of [
  "ubuntu-24.04-arm",
  "Package Linux DEB",
  "Publish Linux DEB artifacts",
  "Publish release notes",
  "scripts/extract-release-notes.mjs",
  "--notes-file",
  ".body | length",
  "PWRAGENT_LINUX_ARCH",
  "SHA256SUMS",
  "scripts/release/install-trusted-signing.ps1",
  "--win --no-publish --require-signing",
]) {
  if (!releaseWorkflow.includes(expected)) {
    fail(`.github/workflows/release.yml must contain ${JSON.stringify(expected)}`);
  }
}
assertWorkflowJobRunner(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-package",
  "windows-2022",
);
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-package",
  "scripts/release/install-trusted-signing.ps1",
  "--win --no-publish --require-signing",
);
for (const expected of [
  "Install-Module",
  "-Name TrustedSigning",
  "-MinimumVersion 0.5.0",
  "Get-Command Invoke-TrustedSigning",
  "-NoProfile -NonInteractive -Command",
]) {
  if (!trustedSigningSetup.includes(expected)) {
    fail(`scripts/release/install-trusted-signing.ps1 must contain ${JSON.stringify(expected)}`);
  }
}
for (const stepName of [
  "Upload release artifacts (debug retention)",
  "Upload Linux artifacts (debug retention)",
]) {
  assertWorkflowStepContinuesOnError(
    releaseWorkflow,
    ".github/workflows/release.yml",
    stepName,
  );
}

for (const expected of [
  "PwrAgent-linux-x64.deb",
  "PwrAgent-linux-arm64.deb",
  "SHA256SUMS",
  "born as GitHub `Pre-release`",
]) {
  if (!desktopReleaseRunbook.includes(expected)) {
    fail(`docs/desktop-release-runbook.md must contain ${JSON.stringify(expected)}`);
  }
}

if (process.exitCode) {
  process.exit();
}

console.log(`release metadata check passed for ${tag}`);
