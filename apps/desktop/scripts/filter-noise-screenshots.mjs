#!/usr/bin/env node
//
// Revert PNGs in the tracked screenshot directories whose pixels
// are identical to the committed (HEAD) version.
//
// Why: macOS `screencapture` re-encodes its output every run, so
// even a deterministic-input capture can land with a different
// byte stream than what's in git. PNGs don't delta-compress in
// git's pack format — every byte-different commit adds ~900 KB
// per file to .git regardless of whether anything visible
// changed. Running this script after `screenshot:readme` /
// `screenshot:docs-site` reverts the no-op re-encodes while
// keeping any captures whose pixels actually changed.
//
// Mechanics: for each modified PNG under the target dirs,
// extract HEAD's blob, normalize both to TIFF via `sips` (lossless,
// canonical encoding), SHA-256 the TIFFs, compare. Same SHA →
// `git restore --source=HEAD --worktree` to drop the working-tree
// change.
//
// Untracked / newly-added PNGs are left alone — they're net-new
// content, not re-encode noise. Staged changes are left alone too
// (the restore is worktree-only).
//
// macOS-only because the screenshot pipeline is macOS-only (Swift
// `screencapture` + Screen Recording permission).
//
// Usage:
//   node filter-noise-screenshots.mjs
//     Default — scans PwrAgent's `docs/assets/screenshots/` (the
//     README capture set).
//   node filter-noise-screenshots.mjs --root <path>
//     Treats <path> as a separate git repo and scans every
//     modified PNG inside it (used after `screenshot:docs-site` to
//     filter PNGs landing in the sibling docs.pwragent.ai
//     checkout, which is a screenshots-only repo so no dir filter
//     is needed).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const rootArgIndex = args.indexOf("--root");
const externalRoot =
  rootArgIndex !== -1 && rootArgIndex + 1 < args.length
    ? args[rootArgIndex + 1]
    : null;

// In default mode we filter to known screenshot dirs to avoid
// touching random PNGs elsewhere in the repo. In --root mode the
// target repo is assumed to be screenshots-only (e.g.
// docs.pwragent.ai) so we scan every modified .png.
const TARGET_DIRS = ["docs/assets/screenshots/"];

function repoRoot() {
  if (externalRoot) {
    const resolved = path.resolve(externalRoot.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
    if (!existsSync(resolved)) {
      console.error(`filter-noise-screenshots: --root path not found: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function listModifiedPngs(root) {
  const status = execFileSync("git", ["status", "--porcelain", "--"], {
    cwd: root,
    encoding: "utf8",
  });
  const paths = status
    .split("\n")
    .filter((line) => /^[ MA]M /.test(line) || /^M[ MA] /.test(line))
    .map((line) => line.slice(3).trim())
    .filter((p) => p.endsWith(".png"));
  if (externalRoot) return paths;
  return paths.filter((p) => TARGET_DIRS.some((dir) => p.startsWith(dir)));
}

function extractHeadBlob(root, relPath, outPath) {
  const result = spawnSync("git", ["show", `HEAD:${relPath}`], {
    cwd: root,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) return false;
  writeFileSync(outPath, result.stdout);
  return true;
}

function pixelHashViaSips(pngPath, tmpDir, tag) {
  const tiffPath = path.join(tmpDir, `${tag}.tiff`);
  const result = spawnSync(
    "sips",
    ["-s", "format", "tiff", pngPath, "--out", tiffPath],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
  if (result.status !== 0) return null;
  try {
    return createHash("sha256").update(readFileSync(tiffPath)).digest("hex");
  } catch {
    return null;
  }
}

function restoreFromHead(root, relPath) {
  execFileSync("git", ["restore", "--source=HEAD", "--worktree", "--", relPath], {
    cwd: root,
    stdio: "ignore",
  });
}

function main() {
  const root = repoRoot();
  const modified = listModifiedPngs(root);

  if (modified.length === 0) {
    console.log("filter-noise-screenshots: no modified PNGs under tracked screenshot dirs.");
    return;
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "filter-noise-"));
  let reverted = 0;
  let kept = 0;
  let skipped = 0;

  try {
    for (const relPath of modified) {
      const absWork = path.join(root, relPath);
      const headPath = path.join(tmpDir, "head.png");

      if (!extractHeadBlob(root, relPath, headPath)) {
        console.log(`  skip (no HEAD blob): ${relPath}`);
        skipped += 1;
        continue;
      }

      const headHash = pixelHashViaSips(headPath, tmpDir, "head");
      const workHash = pixelHashViaSips(absWork, tmpDir, "work");

      if (!headHash || !workHash) {
        console.log(`  skip (sips decode failed): ${relPath}`);
        skipped += 1;
        continue;
      }

      if (headHash === workHash) {
        restoreFromHead(root, relPath);
        console.log(`  revert (pixels identical): ${relPath}`);
        reverted += 1;
      } else {
        console.log(`  keep   (visible change):   ${relPath}`);
        kept += 1;
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const tail = `${reverted} reverted, ${kept} kept${skipped ? `, ${skipped} skipped` : ""}.`;
  console.log(`filter-noise-screenshots: ${tail}`);
}

main();
