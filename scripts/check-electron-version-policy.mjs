#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalizeLockVersion(value) {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\(.+\)$/, "");
}

export function readDesktopElectronVersion(lockfileText) {
  const lines = lockfileText.split(/\r?\n/);
  let inDesktopImporter = false;
  let inDevDependencies = false;
  let inElectron = false;

  for (const line of lines) {
    if (line === "  apps/desktop:") {
      inDesktopImporter = true;
      continue;
    }
    if (!inDesktopImporter) continue;
    if (/^\S/.test(line) || /^  \S/.test(line)) break;

    if (line === "    devDependencies:") {
      inDevDependencies = true;
      continue;
    }
    if (!inDevDependencies) continue;
    if (/^    \S/.test(line)) break;

    if (line === "      electron:") {
      inElectron = true;
      continue;
    }
    if (!inElectron) continue;
    if (/^      \S/.test(line)) break;

    const versionMatch = /^        version:\s*(\S+)/.exec(line);
    if (versionMatch) {
      return normalizeLockVersion(versionMatch[1]);
    }
  }

  return undefined;
}

export function readPackagedElectronVersion(builderConfig) {
  const match = /^electronVersion:\s*([^\s#]+)/m.exec(builderConfig);
  return match ? normalizeLockVersion(match[1]) : undefined;
}

export function checkElectronVersionPolicy(root = repoRoot) {
  const lockfilePath = join(root, "pnpm-lock.yaml");
  const builderConfigPath = join(root, "apps", "desktop", "electron-builder.yml");
  const resolvedElectron = readDesktopElectronVersion(
    readFileSync(lockfilePath, "utf8"),
  );
  const packagedElectron = readPackagedElectronVersion(
    readFileSync(builderConfigPath, "utf8"),
  );

  if (!resolvedElectron) {
    return [
      "pnpm-lock.yaml is missing the apps/desktop Electron runtime version",
    ];
  }
  if (!packagedElectron) {
    return [
      "apps/desktop/electron-builder.yml is missing electronVersion",
    ];
  }
  if (resolvedElectron === packagedElectron) return [];

  return [
    "Electron runtime versions must match exactly; "
      + `pnpm-lock.yaml resolves electron@${resolvedElectron}, `
      + `apps/desktop/electron-builder.yml packages electron@${packagedElectron}`,
  ];
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const failures = checkElectronVersionPolicy();
  if (failures.length > 0) {
    console.error("Electron version policy check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Electron version policy check passed");
  }
}
