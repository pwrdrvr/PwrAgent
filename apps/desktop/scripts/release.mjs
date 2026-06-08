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
 *                       sign/notarize/publish an already prepared release-stage
 *                       without reinstalling dependencies or rerunning tests
 *       --linux       : build/package a Linux .deb for the current native
 *                       architecture (or PWRAGENT_LINUX_ARCH=x64|arm64)
 *       --win         : build/package a Windows x64 NSIS installer (unsigned;
 *                       no publish). Run on a Windows host/runner.
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

if (prepareOnly && signStageOnly) {
  throw new Error("--prepare-only and --sign-stage-only cannot be combined");
}

if (linux && signStageOnly) {
  throw new Error("--linux cannot be combined with --sign-stage-only");
}

if (win && signStageOnly) {
  throw new Error("--win cannot be combined with --sign-stage-only");
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
    // On Windows `pnpm` is a .cmd shim that spawnSync only resolves through a
    // shell (and Node refuses to spawn .cmd without one). Repo/stage paths here
    // contain no spaces, so unquoted shell args are safe.
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`  ! failed to spawn ${file}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
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
  step("electron-builder --win nsis --x64 (no builder publish)");
  builderArgs.push("--win", "nsis", "--x64", "--publish=never");
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
    // Ad-hoc signing creates a locally valid signature that satisfies
    // macOS page validation without requiring a Developer ID certificate.
    builderArgs.push("--config.mac.identity=-", "--config.mac.notarize=false");
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
