#!/usr/bin/env node

import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlatformSigningInput, signingInputPaths } from "./check-signing-input.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// fs.cp copies each regular file, rather than retaining the source tree's
// hard-link graph. Windows tar.exe otherwise writes hard-link records that can
// point outside the explicit signing-input manifest.
export function materializeSigningInput(
  platform,
  destinationRoot,
  paths = signingInputPaths[platform],
  sourceRoot = repoRoot,
) {
  checkPlatformSigningInput(platform, paths, sourceRoot);
  const destination = resolve(destinationRoot);
  mkdirSync(destination, { recursive: true });
  for (const path of paths) {
    const source = resolve(sourceRoot, path);
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, destination] = process.argv.slice(2);
  if (!platform || !destination) {
    console.error("Usage: materialize-signing-input.mjs <macos|windows> <destination>");
    process.exitCode = 1;
  } else {
    try {
      materializeSigningInput(platform, destination);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
