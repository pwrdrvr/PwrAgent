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
 *       (default)     : build + package signed/notarized + publish to the
 *                       channel configured in electron-builder.yml
 *   - In CI, the App Store Connect API key may arrive as a base64-encoded
 *     env var (`APPLE_API_KEY_BASE64`) instead of a file path. This script
 *     decodes it to a temp file and re-exports `APPLE_API_KEY` for
 *     electron-builder before invoking it. Local runs that already have
 *     `APPLE_API_KEY=/path/to/AuthKey.p8` are passed through unchanged.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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
const publish = !dryrun && !noPublish;

function step(label) {
  console.log(`\n→ ${label}`);
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: opts.cwd ?? desktopRoot, env: { ...process.env, ...opts.env } });
}

function runChecked(file, args, opts = {}) {
  console.log(`  $ ${file} ${args.join(" ")}`);
  const result = spawnSync(file, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? desktopRoot,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCaptured(file, args, opts = {}) {
  console.log(`  $ ${file} ${args.join(" ")}`);
  const result = spawnSync(file, args, {
    cwd: opts.cwd ?? desktopRoot,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
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
  process.env.APPLE_API_KEY = target;
  console.log(`  decoded APPLE_API_KEY_BASE64 -> ${target}`);
}

function applyDmgFileIcons(distDir) {
  if (process.platform !== "darwin") {
    console.log("  skipping Finder file icon step outside macOS");
    return;
  }

  const dmgFiles = readdirSync(distDir)
    .filter((name) => name.endsWith(".dmg"))
    .map((name) => join(distDir, name));

  if (dmgFiles.length === 0) {
    throw new Error(`No DMG artifacts found in ${distDir}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pwragent-dmg-icon-"));
  try {
    const iconPath = join(tempDir, "icon.icns");
    const resourcePath = join(tempDir, "icon.rsrc");
    copyFileSync(join(stageDir, "build", "icon.icns"), iconPath);

    // Finder file icons are stored in the file's resource fork plus the
    // custom-icon Finder flag. The DMG volume icon alone does not affect the
    // unmounted .dmg file as shown in Downloads.
    runChecked("sips", ["-i", iconPath]);
    const resource = runCaptured("DeRez", ["-only", "icns", iconPath]);
    writeFileSync(resourcePath, resource);

    for (const dmgFile of dmgFiles) {
      runChecked("Rez", ["-append", resourcePath, "-o", dmgFile]);
      runChecked("SetFile", ["-a", "C", dmgFile]);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// 2. Build (electron-vite -> apps/desktop/out/).
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

// 4. Copy the build output and electron-builder inputs into the stage so
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
  run(`cp -R ${join(desktopRoot, dir)} ${target}`);
}
run(`cp ${join(desktopRoot, "electron-builder.yml")} ${join(stageDir, "electron-builder.yml")}`);

// 5. electron-builder.
step(`electron-builder --mac --arm64 (${publish ? "publish" : "no publish"}, ${dryrun ? "ad-hoc signed" : "signed"})`);
maybeDecodeAppleApiKey();
const builderArgs = ["electron-builder", "--mac", "--arm64"];
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
const cleanedArgs = builderArgs.filter((arg) => arg !== "");
runChecked("npx", cleanedArgs, { cwd: stageDir });

// 6. Apply a Finder file icon to the unmounted DMG artifacts. This is separate
//    from `dmg.icon`, which controls the mounted volume icon.
step("apply Finder file icons to DMG artifacts");
applyDmgFileIcons(join(stageDir, "dist"));

// 7. Post-build asar contents check — fails if forbidden files (TS sources,
//    tests, third-party docs, design docs, screenshots, etc.) leaked into the
//    bundle. Exclusions are configured in electron-builder.yml; this script
//    is a belt-and-braces guard against accidental edits to that YAML.
step("verify packaged asar contents");
const builtApp = join(stageDir, "dist", "mac-arm64", "PwrAgent.app");
runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp]);

step("done");
const dist = join(stageDir, "dist");
console.log(`  artifacts: ${dist}`);
