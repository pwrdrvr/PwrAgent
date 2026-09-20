#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPlatformRuntimeClosure,
  checkPlatformSigningInput,
  signingInputPaths,
} from "./check-signing-input.mjs";

function tarCommand() {
  return process.platform === "win32" ? "tar.exe" : "tar";
}

// Verify the payload that the protected job will expand, not its pre-archive
// source tree. This catches tar link records whose targets are outside the
// manifest before a signing environment can be requested.
export function verifySigningInputArchive(
  platform,
  archivePath,
  paths = signingInputPaths[platform],
) {
  const archive = resolve(archivePath);
  const archiveDirectory = dirname(archive);
  const extractionRoot = mkdtempSync(join(
    archiveDirectory,
    `pwragent-${platform}-signing-input-`,
  ));
  try {
    const expanded = spawnSync(
      tarCommand(),
      ["-xzf", basename(archive), "-C", basename(extractionRoot)],
      { cwd: archiveDirectory, encoding: "utf8" },
    );
    if (expanded.error || expanded.status !== 0) {
      throw new Error(
        `Failed to expand ${platform} signing input: ${expanded.error?.message || expanded.stderr}`,
      );
    }
    checkPlatformSigningInput(platform, paths, extractionRoot);
    checkPlatformRuntimeClosure(platform, extractionRoot);
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, archivePath] = process.argv.slice(2);
  if (!platform || !archivePath) {
    console.error("Usage: verify-signing-input-archive.mjs <macos|windows> <archive>");
    process.exitCode = 1;
  } else {
    try {
      verifySigningInputArchive(platform, archivePath);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
