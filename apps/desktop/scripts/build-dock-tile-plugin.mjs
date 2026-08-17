#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("[build-dock-tile-plugin] non-macOS platform — skipping");
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const sourceRoot = join(desktopRoot, "native", "dock-tile-plugin");
const outputBundle = join(
  desktopRoot,
  "build",
  "native",
  "PwrAgentDockTilePlugin.plugin",
);
const contentsDir = join(outputBundle, "Contents");
const executableDir = join(contentsDir, "MacOS");
const executablePath = join(executableDir, "PwrAgentDockTilePlugin");

rmSync(outputBundle, { force: true, recursive: true });
mkdirSync(executableDir, { recursive: true });
copyFileSync(join(sourceRoot, "Info.plist"), join(contentsDir, "Info.plist"));

const compile = spawnSync(
  "xcrun",
  [
    "clang",
    "-fobjc-arc",
    "-O2",
    "-bundle",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-mmacosx-version-min=12.0",
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    join(sourceRoot, "PwrAgentDockTilePlugin.m"),
    "-o",
    executablePath,
  ],
  { stdio: "inherit" },
);
if (compile.status !== 0 || !existsSync(executablePath)) {
  throw new Error(
    `[build-dock-tile-plugin] compilation failed (exit ${compile.status})`,
  );
}

const sign = spawnSync(
  "codesign",
  ["--sign", "-", "--force", "--options", "runtime", outputBundle],
  { stdio: "inherit" },
);
if (sign.status !== 0) {
  throw new Error(
    `[build-dock-tile-plugin] ad-hoc signing failed (exit ${sign.status})`,
  );
}

console.log(
  `[build-dock-tile-plugin] universal bundle → ${outputBundle}`,
);
