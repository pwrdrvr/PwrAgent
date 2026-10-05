#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LINUX_ARCHITECTURES,
  LINUX_PACKAGE_EXTENSIONS,
  linuxReleaseArtifactNames,
} from "../apps/desktop/scripts/linux-release-artifacts.mjs";

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
const previewBuildWorkflowPath = resolve(repoRoot, ".github/workflows/preview-build.yml");
const selectXcodeForActoolPath = resolve(
  repoRoot,
  ".github/actions/select-xcode-for-actool/action.yml",
);
const trustedSigningSetupPath = resolve(
  repoRoot,
  "scripts/release/install-trusted-signing.ps1",
);
const windowsArchiveScriptPath = resolve(
  repoRoot,
  "scripts/release/archive-windows-signing-input.ps1",
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

function sameValues(actual, expected) {
  return actual.length === expected.length
    && expected.every((value) => actual.includes(value));
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

function assertWorkflowJobContainsText(workflow, workflowPath, jobName, expected) {
  const jobBody = workflowJobBody(workflow, workflowPath, jobName);
  if (!jobBody.includes(expected)) {
    fail(`${workflowPath} ${jobName} must contain ${JSON.stringify(expected)}`);
  }
}

function assertWorkflowJobNeeds(workflow, workflowPath, jobName, dependency) {
  const jobBody = workflowJobBody(workflow, workflowPath, jobName);
  const needs = jobBody.match(/^    needs:\n((?:      - [A-Za-z0-9_-]+\n)+)/m);
  if (!needs?.[1].split("\n").includes(`      - ${dependency}`)) {
    fail(`${workflowPath} ${jobName} must depend on ${dependency}`);
  }
}

function assertWorkflowStepContainsText(workflow, workflowPath, jobName, stepName, expected) {
  const jobBody = workflowJobBody(workflow, workflowPath, jobName);
  const stepPattern = new RegExp(`^      - name: ${escapeRegex(stepName)}\\n`, "m");
  const match = jobBody.match(stepPattern);
  const remainder = match ? jobBody.slice(match.index + match[0].length) : "";
  const nextStepOffset = remainder.search(/^      - /m);
  const stepBody = nextStepOffset === -1 ? remainder : remainder.slice(0, nextStepOffset);
  if (!stepBody.includes(expected)) {
    fail(`${workflowPath} ${jobName} ${stepName} must contain ${JSON.stringify(expected)}`);
  }
}

function assertWorkflowJobExcludesText(workflow, workflowPath, jobName, unexpected) {
  const jobBody = workflowJobBody(workflow, workflowPath, jobName);
  if (jobBody.includes(unexpected)) {
    fail(`${workflowPath} ${jobName} must not contain ${JSON.stringify(unexpected)}`);
  }
}

function assertWorkflowTextOnlyInJob(workflow, workflowPath, jobName, expected) {
  const jobBody = workflowJobBody(workflow, workflowPath, jobName);
  if (!jobBody.includes(expected)) {
    fail(`${workflowPath} ${jobName} must contain ${JSON.stringify(expected)}`);
    return;
  }
  if (workflow.replace(jobBody, "").includes(expected)) {
    fail(`${workflowPath} must contain ${JSON.stringify(expected)} only in ${jobName}`);
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

// Legacy hoisted Windows deploy resolves this first-party pin again, even
// when a frozen workspace install already succeeded inside the age window.
const protocolPackage = "@pwrdrvr/codex-app-server-protocol";
const protocolException = `${protocolPackage}@${desktopPackage.dependencies[protocolPackage]}`;
const workspaceConfig = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8");
const ageExclusions = workspaceConfig.match(/^minimumReleaseAgeExclude:\n((?:[ \t].*\n)*)/m)?.[1] || "";
const protocolExceptionPattern = new RegExp(
  `^  - ['"]?${escapeRegex(protocolException)}['"]?\\s*$`,
  "m",
);
if (!protocolExceptionPattern.test(ageExclusions)) {
  fail(`pnpm-workspace.yaml minimumReleaseAgeExclude must contain the exact desktop protocol pin ${protocolException}`);
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
const previewBuildWorkflow = readFileSync(previewBuildWorkflowPath, "utf8");
const selectXcodeForActool = readFileSync(selectXcodeForActoolPath, "utf8");
const trustedSigningSetup = readFileSync(trustedSigningSetupPath, "utf8");
const windowsArchiveScript = readFileSync(windowsArchiveScriptPath, "utf8");
const asarVerifier = readFileSync(
  resolve(repoRoot, "apps/desktop/scripts/verify-asar-contents.mjs"),
  "utf8",
);
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
  "artifactName: \"${productName}-${version}-linux-${arch}.${ext}\"",
  // Pins the Windows Add or Remove Programs name. Without an explicit value
  // electron-builder falls back to "${productName} ${version}", which repeats
  // the version next to the ARP Version column.
  "uninstallDisplayName: PwrAgent",
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

// Artifact names live in the reusable helper, rather than release.mjs. Keep
// the complete supported set and existing download URLs pinned at this gate.
const linuxArtifactArchNames = {
  x64: { deb: "amd64", rpm: "x86_64", pacman: "x64", "tar.gz": "x64" },
  arm64: { deb: "arm64", rpm: "aarch64", pacman: "aarch64", "tar.gz": "arm64" },
};
if (!sameValues(LINUX_ARCHITECTURES, ["x64", "arm64"])) {
  fail("Linux release artifacts must support x64 and arm64");
}
if (!sameValues(LINUX_PACKAGE_EXTENSIONS, ["deb", "rpm", "pacman", "tar.gz"])) {
  fail("Linux release artifacts must support DEB, RPM, pacman and tar.gz");
}
const expectedLinuxArtifacts = Object.entries(linuxArtifactArchNames).flatMap(
  ([arch, formats]) => Object.entries(formats).flatMap(([extension, artifactArch]) => [
    `PwrAgent-${expectedVersion}-linux-${artifactArch}.${extension}`,
    `PwrAgent-linux-${arch}.${extension}`,
  ]),
);
if (!sameValues(linuxReleaseArtifactNames(expectedVersion, LINUX_ARCHITECTURES), expectedLinuxArtifacts)) {
  fail("Linux release artifacts must retain every versioned package and stable alias with format-specific architecture names");
}
const linuxBuilderConfig = electronBuilderConfig.split(/^linux:\n/m)[1]?.split(/^\S/m)[0] || "";
for (const extension of LINUX_PACKAGE_EXTENSIONS) {
  const targetPattern = new RegExp(
    `^    - target: ${escapeRegex(extension)}\\n      arch: \\[x64, arm64\\]$`,
    "m",
  );
  if (!targetPattern.test(linuxBuilderConfig)) {
    fail(`apps/desktop/electron-builder.yml must target Linux ${extension} on x64 and arm64`);
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
  "from \"./linux-release-artifacts.mjs\"",
  "builderArgs.push(\"--linux\", ...LINUX_PACKAGE_EXTENSIONS, `--${linuxArch}`, \"--publish=never\")",
  "createLinuxStableAliases(dist, version, linuxArch)",
  "writeLinuxChecksums(dist, version, [linuxArch])",
  "linuxReleaseArtifactNames(version, [currentLinuxBuilderArch()])",
  "requireUpdateChannelFile(dist, channelFile)",
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
  "ci:windows-package",
  "--win --prepare-only",
  "--win --sign-stage-only --no-publish",
  "archive-windows-signing-input.ps1",
]) {
  if (!ciWorkflow.includes(expected)) {
    fail(`.github/workflows/ci.yml must contain ${JSON.stringify(expected)}`);
  }
}
for (const unexpected of [
  "ci:windows-signing",
  "  windows-signing-preflight:",
  "  windows-signing:",
  "environment: windows-signing",
]) {
  if (ciWorkflow.includes(unexpected)) {
    fail(`.github/workflows/ci.yml must not contain ${JSON.stringify(unexpected)}`);
  }
}
assertWorkflowJobRunner(
  ciWorkflow,
  ".github/workflows/ci.yml",
  "windows-package",
  "windows-latest",
);
assertWorkflowJobRunner(
  ciWorkflow,
  ".github/workflows/ci.yml",
  "macos-install-deps",
  "macos-26",
);
for (const unexpected of [
  "ci:windows-signing",
  "environment: windows-signing",
  "scripts/release/install-trusted-signing.ps1",
  "--require-signing",
]) {
  assertWorkflowJobExcludesText(
    ciWorkflow,
    ".github/workflows/ci.yml",
    "windows-package",
    unexpected,
  );
}

for (const expected of [
  "ubuntu-24.04-arm",
  "Publish release assets",
  "Publish release notes",
  "scripts/extract-release-notes.mjs",
  "--notes-file",
  ".body | length",
  "PWRAGENT_LINUX_ARCH",
  "SHA256SUMS",
  "windows-release-signing-input",
  "windows-installer",
  "EXPECTED_SHA256",
  "scripts/release/install-trusted-signing.ps1",
  "--win --sign-stage-only --no-publish --require-signing",
]) {
  if (!releaseWorkflow.includes(expected)) {
    fail(`.github/workflows/release.yml must contain ${JSON.stringify(expected)}`);
  }
}
for (const expected of [
  "runs-on: ${{ matrix.runner }}",
  "- builder_arch: x64\n            grok_platform: linux-x86_64\n            runner: ubuntu-24.04",
  "- builder_arch: arm64\n            grok_platform: linux-aarch64\n            runner: ubuntu-24.04-arm",
  "PWRAGENT_LINUX_ARCH: ${{ matrix.builder_arch }}",
  "node apps/desktop/scripts/release.mjs --linux --no-publish",
  "name: linux-packages-${{ matrix.builder_arch }}",
  "apps/desktop/release-stage/dist/latest-linux*.yml",
  ...LINUX_PACKAGE_EXTENSIONS.map((extension) => `apps/desktop/release-stage/dist/*.${extension}`),
]) {
  assertWorkflowJobContainsText(releaseWorkflow, ".github/workflows/release.yml", "linux-package", expected);
}
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "linux-package",
  "node apps/desktop/scripts/release.mjs --linux --no-publish",
  "Upload Linux package artifact",
);
assertWorkflowJobRunner(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "prepare",
  "macos-26",
);
assertWorkflowJobRunner(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "sign",
  "macos-26",
);
assertWorkflowJobRunner(
  previewBuildWorkflow,
  ".github/workflows/preview-build.yml",
  "preview",
  "macos-26",
);
for (const expected of [
  "Select an Xcode with actool 26",
  "DEVELOPER_DIR: ${{ steps.xcode.outputs.developer-dir }}",
  "PWRAGENT_REQUIRE_ACTOOL: \"1\"",
]) {
  assertWorkflowJobContainsText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "prepare",
    expected,
  );
}
for (const expected of [
  "host_version=\"$(sw_vers -productVersion)\"",
  "Use runs-on: macos-26 for Icon Composer packaging.",
]) {
  if (!selectXcodeForActool.includes(expected)) {
    fail(`${selectXcodeForActoolPath} must contain ${JSON.stringify(expected)}`);
  }
}
assertWorkflowJobRunner(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-prepare",
  "windows-latest",
);
assertWorkflowJobRunner(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-sign",
  "windows-2022",
);
for (const expected of [
  "actions/checkout@",
  "configure-nodejs@",
  "--win --prepare-only",
  "signing-input-sha256: ${{ steps.archive.outputs.sha256 }}",
  "Archive Windows signing input",
  "Upload Windows signing input",
  "archive-windows-signing-input.ps1",
]) {
  assertWorkflowJobContainsText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "windows-prepare",
    expected,
  );
}
for (const unexpected of [
  "environment: windows-signing",
  "secrets.",
  "      - name: Install TrustedSigning",
  "--require-signing",
  "apps/desktop/node_modules",
  "            \"node_modules\"",
]) {
  assertWorkflowJobExcludesText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "windows-prepare",
    unexpected,
  );
}
for (const expected of [
  "environment: windows-signing",
  "Download Windows signing input",
  "Verify Windows signing input",
  "Expand Windows signing input",
  "scripts/release/install-trusted-signing.ps1",
  "secrets.AZURE_CLIENT_SECRET",
  "--win --sign-stage-only --no-publish --require-signing",
  "Prepare stable-name Windows installer alias",
  "node apps/desktop/scripts/windows-release-artifacts.mjs",
  "PwrAgent.Setup.exe",
]) {
  assertWorkflowJobContainsText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "windows-sign",
    expected,
  );
}
// The alias is a copy of an already-signed installer, so it must be made after
// packaging and before the upload that feeds publish-release-assets. Copying
// earlier would publish a stable-name .exe without an Authenticode signature.
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-sign",
  "--win --sign-stage-only --no-publish --require-signing",
  "Prepare stable-name Windows installer alias",
);
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-sign",
  "Prepare stable-name Windows installer alias",
  "Upload Windows installer artifact",
);
for (const expected of [
  "--sign-stage-only --no-publish",
  "--sign-stage-only --no-publish --mac-arch=arm64",
  "node apps/desktop/scripts/assemble-mac-release.mjs",
  "apps/desktop/release-stage/dist/PwrAgent-macos-SHA256SUMS",
  "Upload macOS release assets",
]) {
  assertWorkflowJobContainsText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "sign",
    expected,
  );
}
for (const expected of [
  "stage-grok-bundle.mjs --platform macos-aarch64",
  "--prepare-only --mac-arch=arm64",
]) {
  assertWorkflowJobContainsText(releaseWorkflow, ".github/workflows/release.yml", "prepare", expected);
}
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "sign",
  "--sign-stage-only --no-publish --mac-arch=arm64",
  "node apps/desktop/scripts/assemble-mac-release.mjs",
);
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "sign",
  "node apps/desktop/scripts/assemble-mac-release.mjs",
  "Upload macOS release assets",
);
for (const unexpected of [
  "gh release upload",
  "continue-on-error: true",
]) {
  assertWorkflowJobExcludesText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "sign",
    unexpected,
  );
}
for (const expected of [
  "linux-package",
  "sign",
  "windows-sign",
  "Checkout repository",
  "Download macOS release artifacts",
  "Download Windows installer artifact",
  "Name Windows checksum manifest",
  "Create release and publish all platform assets",
  "gh release create",
  "--verify-tag",
  "--prerelease",
  "isPrerelease",
  "was not created as a GitHub Pre-release",
  "windows-dist/*",
  "PwrAgent-windows-SHA256SUMS",
  "pattern: linux-packages-*",
  "merge-multiple: true",
  "node apps/desktop/scripts/linux-release-artifacts.mjs linux-dist \"${RELEASE_TAG#v}\"",
  "node apps/desktop/scripts/update-channel-files.mjs",
  "verify-staged",
  "--version \"${RELEASE_TAG#v}\"",
  "mac-dist windows-dist linux-dist",
  "verify-published \"$RUNNER_TEMP/release-asset-names.txt\"",
]) {
  assertWorkflowJobContainsText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "publish-release-assets",
    expected,
  );
}
// Scope payload checks to the actual publication step: debug retention must
// not hide an installer, checksum manifest or updater feed omitted from GitHub.
for (const expected of [
  "mac-dist/*",
  "windows-dist/*",
  "linux-dist/latest-linux*.yml",
  "linux-dist/SHA256SUMS",
  ...LINUX_PACKAGE_EXTENSIONS.map((extension) => `linux-dist/*.${extension}`),
]) {
  assertWorkflowStepContainsText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "publish-release-assets",
    "Create release and publish all platform assets",
    expected,
  );
}
for (const dependency of ["linux-package", "sign", "windows-sign"]) {
  assertWorkflowJobNeeds(releaseWorkflow, ".github/workflows/release.yml", "publish-release-assets", dependency);
}
for (const [first, second] of [
  ["Download Linux package artifacts", "node apps/desktop/scripts/linux-release-artifacts.mjs"],
  ["node apps/desktop/scripts/linux-release-artifacts.mjs", "Create release and publish all platform assets"],
  ["verify-staged", "Create release and publish all platform assets"],
  ["gh release create", "verify-published"],
]) {
  assertWorkflowJobOrdersText(releaseWorkflow, ".github/workflows/release.yml", "publish-release-assets", first, second);
}
// Every release is published as a GitHub Pre-release. Promotion to Latest is a
// deliberate operator action after the assets and smoke checks are validated,
// so CI must never pass --latest.
assertWorkflowJobExcludesText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "publish-release-assets",
  "--latest",
);
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "publish-release-assets",
  "Name Windows checksum manifest",
  "Create release and publish all platform assets",
);
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "publish-release-assets",
  "gh release create",
  "was not created as a GitHub Pre-release",
);
assertWorkflowJobContainsText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "publish-release-notes",
  "publish-release-assets",
);
for (const unexpected of [
  "actions/checkout@",
  "configure-nodejs@",
  "pnpm install",
  "--prepare-only",
]) {
  assertWorkflowJobExcludesText(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "windows-sign",
    unexpected,
  );
}
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-sign",
  "Verify Windows signing input",
  "scripts/release/install-trusted-signing.ps1",
);
assertWorkflowJobOrdersText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "windows-sign",
  "scripts/release/install-trusted-signing.ps1",
  "--win --sign-stage-only --no-publish --require-signing",
);
if (releaseScript.includes("--win cannot be combined with --sign-stage-only")) {
  fail("apps/desktop/scripts/release.mjs must allow --win with --sign-stage-only");
}
for (const credential of [
  "vars.WIN_AZURE_SIGN_PUBLISHER_NAME",
  "vars.WIN_AZURE_SIGN_ENDPOINT",
  "vars.WIN_AZURE_SIGN_ACCOUNT",
  "vars.WIN_AZURE_SIGN_PROFILE",
  "secrets.AZURE_TENANT_ID",
  "secrets.AZURE_CLIENT_ID",
  "secrets.AZURE_CLIENT_SECRET",
]) {
  assertWorkflowTextOnlyInJob(
    releaseWorkflow,
    ".github/workflows/release.yml",
    "windows-sign",
    credential,
  );
}
for (const expected of [
  "--config.node-linker=hoisted",
  "signStageOnly && win",
  "PWRAGENT_ASAR_MODULE_ROOT: stageDir",
]) {
  if (!releaseScript.includes(expected)) {
    fail(`apps/desktop/scripts/release.mjs must contain ${JSON.stringify(expected)} for Windows signing input isolation`);
  }
}
for (const expected of [
  "apps/desktop/release-stage/node_modules/.pnpm/node_modules",
  "tar.exe -czf",
]) {
  if (!windowsArchiveScript.includes(expected)) {
    fail(`${windowsArchiveScriptPath} must contain ${JSON.stringify(expected)} for Windows signing input isolation`);
  }
}
if (!asarVerifier.includes("PWRAGENT_ASAR_MODULE_ROOT")) {
  fail("apps/desktop/scripts/verify-asar-contents.mjs must accept the staged ASAR module root");
}
// Use the same manifest and import-closure check as both archive producers.
for (const platform of ["macos", "windows"]) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules",
    resolve(repoRoot, "scripts/release/check-signing-input.mjs"),
    platform,
  ], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(`${platform} signing input: ${result.error?.message || result.stderr}`);
  }
}
assertWorkflowJobContainsText(
  releaseWorkflow,
  ".github/workflows/release.yml",
  "prepare",
  "check-signing-input.mjs macos",
);
if (!windowsArchiveScript.includes("check-signing-input.mjs windows")) {
  fail("Windows archive must use the checked signing input manifest");
}
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
  "Upload assembled release artifacts (debug retention)",
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
  "PwrAgent.Setup.exe",
  "SHA256SUMS",
  "born as a GitHub `Pre-release`",
  "--latest --prerelease=false",
]) {
  if (!desktopReleaseRunbook.includes(expected)) {
    fail(`docs/desktop-release-runbook.md must contain ${JSON.stringify(expected)}`);
  }
}

if (process.exitCode) {
  process.exit();
}

console.log(`release metadata check passed for ${tag}`);
