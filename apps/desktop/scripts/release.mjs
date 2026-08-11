#!/usr/bin/env node
/**
 * PwrAgent desktop release orchestrator.
 *
 * Why this script exists:
 *   - electron-builder's default node_modules walk does not understand pnpm's
 *     symlinked virtual store (`.pnpm/...`). Running it against the workspace
 *     root produces broken bundles. The fix is to first run `pnpm deploy` to
 *     materialize a flat node_modules tree under a stage dir, then point
 *     electron-builder at the stage. This script encapsulates that.
 *   - Three modes:
 *       --dryrun      : build + package unsigned, no publish (fast iteration)
 *       --no-publish  : build + package signed/notarized, no publish (local
 *                       end-to-end verification — Phase E5 in the release
 *                       packaging plan)
 *       --prepare-only: build + prepare release-stage, no package/sign/publish
 *       --sign-stage-only:
 *                       package/sign an already prepared release-stage without
 *                       reinstalling dependencies or rerunning tests. Defaults
 *                       to macOS; combine with --win for Windows NSIS.
 *       --linux       : build/package a Linux .deb for the current native
 *                       architecture (or PWRAGENT_LINUX_ARCH=x64|arm64)
 *       --win         : build/package a Windows x64 NSIS installer (unsigned
 *                       unless Azure signing env is present; no publish). Run
 *                       on a Windows host/runner.
 *       (default)     : build + package signed/notarized + publish to the
 *                       channel configured in electron-builder.yml
 *   - In CI, the App Store Connect API key may arrive as a base64-encoded
 *     env var (`APPLE_API_KEY_BASE64`) instead of a file path. This script
 *     decodes it to a temp file and re-exports `APPLE_API_KEY` for
 *     electron-builder before invoking it. Local runs that already have
 *     `APPLE_API_KEY=/path/to/AuthKey.p8` are passed through unchanged.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const stageDir = join(desktopRoot, "release-stage");

const args = process.argv.slice(2);
const dryrun = args.includes("--dryrun");
const noPublish = args.includes("--no-publish");
const prepareOnly = args.includes("--prepare-only");
const signStageOnly = args.includes("--sign-stage-only");
const linux = args.includes("--linux");
const win = args.includes("--win");
// Release builds pass this so an unsigned Windows installer can never ship
// unnoticed; local/sandbox/PR builds omit it and stay unsigned. See the `win`
// branch below and docs/desktop-windows-signing.md.
const requireSigning = args.includes("--require-signing");

if (prepareOnly && signStageOnly) {
  throw new Error("--prepare-only and --sign-stage-only cannot be combined");
}

if (linux && signStageOnly) {
  throw new Error("--linux cannot be combined with --sign-stage-only");
}

if (win && linux) {
  throw new Error("--win cannot be combined with --linux");
}

const publish = !dryrun && !noPublish && !prepareOnly;

function step(label) {
  console.log(`\n→ ${label}`);
}

function runChecked(file, args, opts = {}) {
  console.log(`  $ ${file} ${args.join(" ")}`);
  const result = spawnSync(file, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? desktopRoot,
    env: { ...process.env, ...opts.env },
    // On Windows only `pnpm` needs a shell (it's a .cmd shim that spawnSync
    // can't resolve directly). `node`/`gh` are real .exe's found without a
    // shell — and NOT using a shell for them keeps args with spaces (e.g. the
    // Azure signing `--config.win.azureSignOptions.publisherName=PwrDrvr LLC`
    // override) intact, since shell:true would word-split them.
    shell: process.platform === "win32" && file === "pnpm",
  });
  if (result.error) {
    console.error(`  ! failed to spawn ${file}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Windows Authenticode signing via Azure Artifact Signing (the service formerly
// and still widely called Trusted Signing). Requires the account config
// (WIN_AZURE_SIGN_*) AND the Microsoft Entra service-principal credentials
// (AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET, which electron-builder's
// bundled TrustedSigning module reads from the environment).
//
// Three outcomes, deliberately: all set -> signed; none set -> UNSIGNED, so
// local, sandbox, and label-gated PR builds still work without secrets; a
// partial set -> throw, because that is always a misconfiguration and silently
// publishing an unsigned installer is the worst of the three.
function resolveWindowsAzureSigning() {
  const config = {
    WIN_AZURE_SIGN_PUBLISHER_NAME:
      process.env.WIN_AZURE_SIGN_PUBLISHER_NAME?.trim(),
    WIN_AZURE_SIGN_ENDPOINT: process.env.WIN_AZURE_SIGN_ENDPOINT?.trim(),
    WIN_AZURE_SIGN_ACCOUNT: process.env.WIN_AZURE_SIGN_ACCOUNT?.trim(),
    WIN_AZURE_SIGN_PROFILE: process.env.WIN_AZURE_SIGN_PROFILE?.trim(),
  };
  const missingConfig = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  // None set: an intentional unsigned build — local dev, the sandbox, or the
  // label-gated PR installer job, none of which are given signing config.
  if (missingConfig.length === Object.keys(config).length) {
    return undefined;
  }
  // Some but not all: nobody sets a subset of these on purpose. It means a
  // typo'd variable name, or a job that never joined the `windows-signing`
  // environment (where these live) and so read them as empty. Fail here —
  // the alternative is a green release that silently shipped an UNSIGNED
  // installer, which nobody notices until a user reports SmartScreen.
  if (missingConfig.length > 0) {
    throw new Error(
      `Windows signing is partially configured — missing: ${missingConfig.join(", ")}. `
        + "Set all of them (see docs/desktop-windows-signing.md) or none to build unsigned.",
    );
  }

  // Config present means signing was requested, so absent credentials are a
  // misconfiguration too, not a cue to quietly downgrade. Checked separately
  // from the block above because AZURE_* are generic Azure SDK names that may
  // legitimately be set in a developer's shell for unrelated work.
  const missingCredentials = Object.entries({
    AZURE_TENANT_ID: process.env.AZURE_TENANT_ID?.trim(),
    AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID?.trim(),
    AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET?.trim(),
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingCredentials.length > 0) {
    throw new Error(
      `Windows signing is configured but its service-principal credentials are missing: ${missingCredentials.join(", ")}. `
        + "Unset the WIN_AZURE_SIGN_* variables to build unsigned instead.",
    );
  }

  return {
    publisherName: config.WIN_AZURE_SIGN_PUBLISHER_NAME,
    endpoint: config.WIN_AZURE_SIGN_ENDPOINT,
    accountName: config.WIN_AZURE_SIGN_ACCOUNT,
    profileName: config.WIN_AZURE_SIGN_PROFILE,
  };
}

function electronBuilderCli() {
  const cli = join(desktopRoot, "node_modules", "electron-builder", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(`electron-builder CLI is missing at ${cli}; signing jobs must use the prepared release artifact`);
  }
  return cli;
}

function currentLinuxBuilderArch() {
  const requested = process.env.PWRAGENT_LINUX_ARCH?.trim();
  const arch = requested || (process.arch === "arm64" ? "arm64" : "x64");
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(
      `PWRAGENT_LINUX_ARCH must be x64 or arm64 when set; got ${JSON.stringify(arch)}`,
    );
  }
  return arch;
}

function findLinuxUnpackedDir(distDir) {
  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^linux(?:-.+)?-unpacked$/.test(entry.name))
    .map((entry) => join(distDir, entry.name))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`No linux unpacked app directory found under ${distDir}`);
  }
  return candidates[0];
}

function linuxDebArtifacts(distDir) {
  const artifacts = readdirSync(distDir)
    .filter((entry) => entry.endsWith(".deb"))
    .sort()
    .map((name) => ({ name, path: join(distDir, name) }));
  if (artifacts.length === 0) {
    throw new Error(`No .deb artifacts found under ${distDir}`);
  }
  return artifacts;
}

function createLinuxStableAliases(distDir) {
  const aliases = [];
  for (const { name, path } of linuxDebArtifacts(distDir)) {
    let alias;
    if (name.includes("-linux-x64.deb") || name.includes("-linux-amd64.deb")) {
      alias = "PwrAgent-linux-x64.deb";
    } else if (name.includes("-linux-arm64.deb")) {
      alias = "PwrAgent-linux-arm64.deb";
    }
    if (!alias || name === alias) {
      continue;
    }
    const aliasPath = join(distDir, alias);
    copyFileSync(path, aliasPath);
    aliases.push(aliasPath);
  }
  return aliases;
}

function writeLinuxChecksums(distDir) {
  const artifacts = linuxDebArtifacts(distDir);
  const lines = artifacts
    .map(({ name, path }) => {
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      return `${digest}  ${name}`;
    })
    .join("\n");
  const checksumPath = join(distDir, "SHA256SUMS");
  writeFileSync(checksumPath, `${lines}\n`);
  return checksumPath;
}

function findWindowsUnpackedDir(distDir) {
  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^win(?:-.+)?-unpacked$/.test(entry.name))
    .map((entry) => join(distDir, entry.name))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`No windows unpacked app directory found under ${distDir}`);
  }
  return candidates[0];
}

function windowsInstallerArtifacts(distDir) {
  const artifacts = readdirSync(distDir)
    .filter((entry) => entry.endsWith(".exe"))
    .sort()
    .map((name) => ({ name, path: join(distDir, name) }));
  if (artifacts.length === 0) {
    throw new Error(`No .exe installer artifacts found under ${distDir}`);
  }
  return artifacts;
}

function writeWindowsChecksums(distDir) {
  const artifacts = windowsInstallerArtifacts(distDir);
  const lines = artifacts
    .map(({ name, path }) => {
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      return `${digest}  ${name}`;
    })
    .join("\n");
  const checksumPath = join(distDir, "SHA256SUMS");
  writeFileSync(checksumPath, `${lines}\n`);
  return checksumPath;
}

function publishLinuxArtifacts(distDir) {
  const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  if (!tag) {
    throw new Error("RELEASE_TAG or GITHUB_REF_NAME is required to publish Linux artifacts");
  }
  const artifacts = linuxDebArtifacts(distDir).map((artifact) => artifact.name);
  const checksum = "SHA256SUMS";
  runChecked(
    "gh",
    ["release", "upload", tag, ...artifacts, checksum, "--repo", "pwrdrvr/PwrAgent", "--clobber"],
    { cwd: distDir },
  );
}

function patchStageDependencyManifests() {
  // pnpm overrides can intentionally install a newer dependency than a
  // package's own manifest range (here: axios, pinned newer than
  // @larksuiteoapi/node-sdk's tilde range). electron-builder's dependency
  // walker validates the deployed manifests before packaging, so keep the
  // disposable release-stage metadata aligned with the tree pnpm deployed.
  //
  // Version-agnostic on purpose: this used to hardcode
  // `@larksuiteoapi+node-sdk@<version>`, which silently skipped the patch
  // every time the SDK bumped (the dir no longer existed), reintroducing the
  // "Production dependency axios not found" packaging failure. Glob the SDK
  // dir and align its axios range to whatever pnpm actually deployed.
  const pnpmDir = join(stageDir, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) {
    return;
  }
  const entries = readdirSync(pnpmDir);
  const axiosDir = entries.find((name) => /^axios@\d/.test(name));
  const deployedAxios = axiosDir ? axiosDir.slice("axios@".length) : undefined;
  if (!deployedAxios) {
    return;
  }
  const desiredAxiosRange = `^${deployedAxios}`;
  for (const sdkDir of entries.filter((name) => /^@larksuiteoapi\+node-sdk@/.test(name))) {
    const manifestPath = join(
      pnpmDir,
      sdkDir,
      "node_modules",
      "@larksuiteoapi",
      "node-sdk",
      "package.json",
    );
    if (!existsSync(manifestPath)) {
      continue;
    }
    const packageJson = JSON.parse(readFileSync(manifestPath, "utf8"));
    const currentRange = packageJson.dependencies?.axios;
    if (!currentRange || currentRange === desiredAxiosRange) {
      continue;
    }
    packageJson.dependencies.axios = desiredAxiosRange;
    writeFileSync(manifestPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    console.log(
      `  patched ${sdkDir} axios range ${currentRange} -> ${desiredAxiosRange} for release-stage dependency collection`,
    );
  }
}

function stageDesktopVersion() {
  const manifestPath = join(stageDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`release-stage package.json is missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("release-stage package.json must contain a non-empty version");
  }
  return manifest.version;
}

function configureStageGithubReleaseType() {
  const configPath = join(stageDir, "electron-builder.yml");
  if (!existsSync(configPath)) {
    throw new Error(`release-stage electron-builder.yml is missing at ${configPath}`);
  }
  const version = stageDesktopVersion();
  const releaseType = version.includes("-") ? "prerelease" : "release";
  const config = readFileSync(configPath, "utf8");
  if (!/^\s*releaseType:\s*\w+\s*$/m.test(config)) {
    throw new Error("electron-builder.yml must contain a publish.releaseType entry");
  }
  const updated = config.replace(
    /^(\s*releaseType:\s*)\w+(\s*)$/m,
    `$1${releaseType}$2`,
  );
  writeFileSync(configPath, updated);
  console.log(`  configured GitHub releaseType=${releaseType} for ${version}`);
}

// 1. Decode CI-provided Apple API key (if present) to a real .p8 file.
function maybeDecodeAppleApiKey() {
  if (process.env.APPLE_API_KEY && existsSync(process.env.APPLE_API_KEY)) {
    return; // already a path; nothing to do
  }
  const base64 = process.env.APPLE_API_KEY_BASE64;
  if (!base64) {
    return; // not set; signing/notarize will fail later if it was needed
  }
  const keyId = process.env.APPLE_API_KEY_ID;
  if (!keyId) {
    throw new Error("APPLE_API_KEY_BASE64 is set but APPLE_API_KEY_ID is missing");
  }
  const target = join(tmpdir(), `AuthKey_${keyId}.p8`);
  writeFileSync(target, Buffer.from(base64, "base64"));
  chmodSync(target, 0o600);
  process.env.APPLE_API_KEY = target;
  console.log("  decoded APPLE_API_KEY_BASE64 -> temporary App Store Connect key file");
}

if (!signStageOnly) {
  // 2. Build (electron-vite -> apps/desktop/out/).
  step("license notices check");
  runChecked("pnpm", ["licenses:check"], { cwd: repoRoot });

  step("electron-vite build");
  runChecked("pnpm", ["--filter", "@pwragent/desktop", "build"], { cwd: repoRoot });

  // 3. Materialize a self-contained, flat node_modules under stage.
  step("pnpm deploy --prod -> release-stage");
  if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  mkdirSync(stageDir, { recursive: true });
  runChecked(
    "pnpm",
    ["deploy", "--filter", "@pwragent/desktop", "--prod", "--legacy", stageDir],
    { cwd: repoRoot },
  );
  patchStageDependencyManifests();

  // 4. Copy the build output, notices, changelog, and electron-builder inputs into the stage so
  //    electron-builder finds them at well-known paths.
  //    pnpm deploy copies the package source tree (including out/ if it exists)
  //    into the stage. Remove stale copies before our controlled cp to avoid
  //    macOS cp -R nesting (cp -R src dst/ creates dst/src/ when dst exists).
  step("seed stage with build output + builder inputs");
  for (const dir of ["out", "build"]) {
    const target = join(stageDir, dir);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    // Cross-platform copy (works on the Windows packaging runner too); target
    // is removed first so cpSync mirrors the source dir without nesting.
    cpSync(join(desktopRoot, dir), target, { recursive: true });
  }
  copyFileSync(
    join(desktopRoot, "electron-builder.yml"),
    join(stageDir, "electron-builder.yml"),
  );
  configureStageGithubReleaseType();
  for (const file of ["LICENSE", "THIRD_PARTY_LICENSES", "CHANGELOG.md"]) {
    copyFileSync(join(repoRoot, file), join(stageDir, file));
  }

  if (prepareOnly) {
    step("prepared release-stage");
    console.log(`  stage: ${stageDir}`);
    process.exit(0);
  }
} else if (!existsSync(stageDir)) {
  throw new Error(`release-stage is missing at ${stageDir}`);
}

// 5. electron-builder.
const builderArgs = [];
if (win) {
  const azureSign = resolveWindowsAzureSigning();
  // The partial-config guard inside resolveWindowsAzureSigning() cannot catch a
  // job that never joined the `windows-signing` environment: there every value
  // reads as empty, which is indistinguishable from an intentional unsigned
  // build. The release workflow passes --require-signing so that case fails
  // instead of quietly publishing an unsigned installer.
  if (requireSigning && !azureSign) {
    throw new Error(
      "--require-signing was passed but no Windows signing configuration is present. "
        + "Check that the job declares `environment: windows-signing` — see docs/desktop-windows-signing.md.",
    );
  }
  step(
    `electron-builder --win nsis --x64 (${azureSign ? "Azure Artifact Signing" : "UNSIGNED"}, no builder publish)`,
  );
  builderArgs.push("--win", "nsis", "--x64", "--publish=never");
  if (azureSign) {
    builderArgs.push(
      `--config.win.azureSignOptions.publisherName=${azureSign.publisherName}`,
      `--config.win.azureSignOptions.endpoint=${azureSign.endpoint}`,
      `--config.win.azureSignOptions.codeSigningAccountName=${azureSign.accountName}`,
      `--config.win.azureSignOptions.certificateProfileName=${azureSign.profileName}`,
    );
  }
} else if (linux) {
  const linuxArch = currentLinuxBuilderArch();
  step(`electron-builder --linux deb --${linuxArch} (no builder publish)`);
  builderArgs.push("--linux", "deb", `--${linuxArch}`, "--publish=never");
} else {
  step(`electron-builder --mac --universal (${publish ? "publish" : "no publish"}, ${dryrun ? "ad-hoc signed" : "signed"})`);
  maybeDecodeAppleApiKey();
  builderArgs.push("--mac", "--universal");
  if (dryrun) {
    // Use ad-hoc signing (identity=-) instead of no signing (identity=null).
    // electron-builder modifies the Electron binary to set fuses, which
    // invalidates its original code signature. Without re-signing, macOS
    // kills the app with SIGKILL (Code Signature Invalid) on launch.
    // Hardened-runtime library validation rejects an ad-hoc signed Electron
    // Framework because neither it nor the main executable has a Developer ID
    // Team ID. Disable hardened runtime only for this disposable dry-run app;
    // signed release builds retain the electron-builder.yml setting.
    builderArgs.push(
      "--config.mac.identity=-",
      "--config.mac.notarize=false",
      "--config.mac.hardenedRuntime=false",
    );
  }
  builderArgs.push(publish ? "--publish" : "--publish=never", publish ? "always" : "");
}
const cleanedArgs = builderArgs.filter((arg) => arg !== "");
runChecked("node", [electronBuilderCli(), ...cleanedArgs], { cwd: stageDir });

// 6. Post-build asar contents check — fails if forbidden files (TS sources,
//    tests, third-party docs, design docs, screenshots, etc.) leaked into the
//    bundle. Exclusions are configured in electron-builder.yml; this script
//    is a belt-and-braces guard against accidental edits to that YAML.
const dist = join(stageDir, "dist");

if (win) {
  const builtApp = findWindowsUnpackedDir(dist);

  step("verify packaged asar contents");
  runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp]);

  step("write Windows checksums");
  const checksumPath = writeWindowsChecksums(dist);
  console.log(`  checksum: ${checksumPath}`);

  step("done");
  console.log(`  artifacts: ${dist}`);
  process.exit(0);
}

if (linux) {
  const builtApp = findLinuxUnpackedDir(dist);

  step("verify packaged asar contents");
  runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp]);

  step("write stable Linux download aliases");
  const aliases = createLinuxStableAliases(dist);
  for (const alias of aliases) {
    console.log(`  alias: ${alias}`);
  }

  step("write Linux checksums");
  const checksumPath = writeLinuxChecksums(dist);
  console.log(`  checksum: ${checksumPath}`);

  if (publish) {
    step("publish Linux artifacts");
    publishLinuxArtifacts(dist);
  }

  step("done");
  console.log(`  artifacts: ${dist}`);
  process.exit(0);
}

const builtApp = join(dist, "mac-universal", "PwrAgent.app");

step("verify universal binary slices");
runChecked("lipo", [
  join(builtApp, "Contents", "MacOS", "PwrAgent"),
  "-verify_arch",
  "x86_64",
  "arm64",
]);
runChecked("lipo", [
  join(
    builtApp,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  ),
  "-verify_arch",
  "x86_64",
  "arm64",
]);

step("verify packaged asar contents");
runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp]);

step("done");
console.log(`  artifacts: ${dist}`);
