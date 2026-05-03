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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

step("done");
const dist = join(stageDir, "dist");
console.log(`  artifacts: ${dist}`);
