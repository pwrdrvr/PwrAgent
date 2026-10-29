#!/usr/bin/env node

import { spawn } from "node:child_process";
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

function diagnosticTail() {
  const limit = 16 * 1024;
  let tail = Buffer.alloc(0);
  let bytes = 0;
  return {
    append(chunk) {
      bytes += chunk.length;
      tail = Buffer.from(Buffer.concat([tail, chunk]).subarray(-limit));
    },
    describe(name) {
      return bytes ? `${name}: ${bytes} bytes${bytes > limit ? " (last 16384 bytes)" : ""}\n${tail.toString("utf8")}` : "";
    },
  };
}

async function expandArchive(platform, archive, extractionRoot, spawnTar) {
  const stdout = diagnosticTail();
  const stderr = diagnosticTail();
  const child = spawnTar(
    tarCommand(),
    ["-xzf", basename(archive), "-C", basename(extractionRoot)],
    { cwd: dirname(archive), stdio: ["ignore", "pipe", "pipe"] },
  );
  let failure;
  child.on("error", (error) => { failure = error; });
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  // 'close' owns completion: 'exit' can precede the final diagnostic bytes.
  const [status, signal] = await new Promise((resolveClose) => {
    child.on("close", (code, signal) => resolveClose([code, signal]));
  });
  const diagnostics = [stdout.describe("tar stdout"), stderr.describe("tar stderr")].filter(Boolean).join("\n");
  if (failure || status !== 0) {
    throw new Error(`Failed to expand ${platform} signing input: ${failure?.message ?? (signal ? `signal ${signal}` : `tar exit ${status}`)}${diagnostics ? `\n${diagnostics}` : ""}`);
  }
  if (diagnostics) console.error(diagnostics);
}

// Verify the payload that the protected job will expand, not its pre-archive
// source tree. This catches tar link records whose targets are outside the
// manifest before a signing environment can be requested.
export async function verifySigningInputArchive(
  platform,
  archivePath,
  paths = signingInputPaths[platform],
  { spawnTar = spawn } = {},
) {
  const archive = resolve(archivePath);
  const archiveDirectory = dirname(archive);
  const extractionRoot = mkdtempSync(join(
    archiveDirectory,
    `pwragent-${platform}-signing-input-`,
  ));
  try {
    await expandArchive(platform, archive, extractionRoot, spawnTar);
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
      await verifySigningInputArchive(platform, archivePath);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
