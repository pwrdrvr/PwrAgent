#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, copyFileSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A Windows installer is named for a human reading a Downloads folder --
// "Claude Setup.exe", "ChatGPT Install.exe" -- not for a build system. Those
// two keep the literal space because they serve from their own CDNs.
//
// We cannot. GitHub Releases rewrites every space in an uploaded asset's
// filename to a period, silently, and a later rename does not put the space
// back. Verified against a draft release on this repository rather than taken
// on faith: `PwrAgent Setup.exe` and `PwrAgent Setup Arm.exe` came back as
// `PwrAgent.Setup.exe` and `PwrAgent.Setup.Arm.exe`, and a PATCH renaming the
// first to `PwrAgent Setup.exe` returned `PwrAgent.Setup.exe` again. See
// https://github.com/orgs/community/discussions/60449.
//
// So name the local artifact what GitHub will store anyway. A space here would
// leave the build output disagreeing with the published asset -- drift that
// shows up only in the release, long after the CI logs have gone green.
//
// These deliberately do not match the macOS and Linux aliases (`PwrAgent.dmg`,
// `PwrAgent-linux-x64.deb`). Those URLs are already published and must keep
// working, and each platform names its installer the way that platform's users
// expect to see it.
export const WINDOWS_ALIAS_NAMES = {
  x64: "PwrAgent.Setup.exe",
  arm64: "PwrAgent.Setup.Arm.exe",
};

const INSTALLER_SUFFIX = "-setup.exe";
// One definition of the manifest's shape. Both halves live in this module --
// writeWindowsChecksums emits it during packaging, readChecksums parses it back
// when the signing job cuts the aliases -- so the reader cannot drift from the
// writer with every unit test still green. Deriving the pattern from the
// separator keeps the two from disagreeing about spacing.
const CHECKSUM_SEPARATOR = "  ";
const CHECKSUM_LINE = new RegExp(`^([0-9a-f]{64})${CHECKSUM_SEPARATOR}(.+)$`);

// The installer is ~150 MB. Stream it the way assemble-mac-release.mjs does
// rather than holding the whole file in a Buffer to hash it.
function digest(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    let count;
    while ((count = readSync(descriptor, buffer)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function installerName(version, arch) {
  return `PwrAgent-${version}-windows-${arch}${INSTALLER_SUFFIX}`;
}

// This scan answers "what did electron-builder build". No alias name ends in
// INSTALLER_SUFFIX, so a previous run's copy is already excluded; a test pins
// that property rather than a guard defending against it.
function windowsInstallerArtifacts(distDir) {
  const artifacts = readdirSync(distDir)
    .filter((entry) => entry.endsWith(INSTALLER_SUFFIX))
    .sort();
  if (artifacts.length === 0) {
    throw new Error(
      `No *${INSTALLER_SUFFIX} found under ${distDir}. `
        + "Check the electron-builder output from the packaging step above.",
    );
  }
  return artifacts;
}

/**
 * Write the checksum manifest for everything electron-builder just packaged.
 * Called by release.mjs at the end of Windows packaging, before any alias
 * exists; writeWindowsReleaseAliases later reads it back and adds the aliases.
 */
export function writeWindowsChecksums(distDir) {
  const entries = new Map(
    windowsInstallerArtifacts(distDir).map((name) => [name, digest(join(distDir, name))]),
  );
  return writeChecksums(distDir, entries);
}

function readChecksums(distDir) {
  const entries = new Map();
  for (const line of readFileSync(join(distDir, "SHA256SUMS"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match === null) throw new Error(`Malformed SHA256SUMS line: ${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

function writeChecksums(distDir, entries) {
  const lines = [...entries].map(([name, sha256]) => `${sha256}${CHECKSUM_SEPARATOR}${name}`);
  const checksumPath = join(distDir, "SHA256SUMS");
  writeFileSync(checksumPath, `${lines.join("\n")}\n`);
  return checksumPath;
}

/**
 * Copy each signed Windows installer to a stable, version-free name beside it,
 * so `releases/latest/download/PwrAgent.Setup.exe` keeps resolving for as long
 * as the product exists. The versioned installer stays exactly where it is:
 * `latest.yml` names it and electron-updater downloads it by that name from a
 * feed pinned to one tag's download directory, so the alias is an additional
 * asset and never a rename.
 *
 * Run this only on an installer whose Authenticode signature is already in
 * place. The alias is a byte-for-byte copy and inherits whatever it copies,
 * including an unsigned intermediate.
 *
 * The aliases do go into `SHA256SUMS`. That is the opposite of leaving them
 * out, which would also be defensible -- the same bytes under a second name
 * state no new fact. But the alias is the name we advertise: README and the
 * runbook send people to `PwrAgent.Setup.exe`, and someone who downloads that
 * and opens the manifest must find the file they actually have. Publishing a
 * download whose own name appears nowhere in the checksums is the worse
 * confusion. `PwrAgent-linux-x64.deb` is already listed the same way, so the
 * repeated digest is an established shape here rather than a new one. Each
 * installer is checked against its recorded entry before it is copied, and the
 * alias is hashed again afterwards, so every published line describes the bytes
 * of the file it names rather than the bytes of some other file.
 */
export function writeWindowsReleaseAliases(distDir, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version.includes("windows")) {
    throw new Error(`Invalid Windows release version: ${version}`);
  }

  // Only this version's installers. release.mjs clears dist for macOS but not
  // for Windows, so a repeated local build leaves earlier versions sitting
  // here; they are not ours to alias and must not look like a broken release.
  const present = windowsInstallerArtifacts(distDir);
  const installers = present.filter((name) => name.startsWith(`PwrAgent-${version}-windows-`));
  if (installers.length === 0) {
    throw new Error(`No Windows installer for ${version} in ${distDir}; found ${present.join(", ")}`);
  }
  const checksums = readChecksums(distDir);

  // Validate every installer before copying any of them, so a release that is
  // wrong in one architecture does not leave a stale alias for another.
  const planned = installers.map((installer) => {
    // An architecture with no agreed alias must fail here rather than publish a
    // release whose stable URL silently points at some other installer.
    const arch = Object.keys(WINDOWS_ALIAS_NAMES).find(
      (candidate) => installer === installerName(version, candidate),
    );
    if (arch === undefined) {
      throw new Error(
        `Unexpected Windows installer ${installer}: no stable alias is defined for it. `
          + `Expected one of ${Object.keys(WINDOWS_ALIAS_NAMES)
            .map((candidate) => installerName(version, candidate))
            .join(", ")}.`,
      );
    }

    const path = join(distDir, installer);
    const sha256 = digest(path);
    const recorded = checksums.get(installer);
    if (recorded === undefined) throw new Error(`SHA256SUMS has no entry for ${installer}`);
    if (recorded !== sha256) {
      throw new Error(`${installer} does not match SHA256SUMS: recorded ${recorded}, got ${sha256}`);
    }
    return { installer, alias: WINDOWS_ALIAS_NAMES[arch], arch, sha256, size: statSync(path).size };
  });

  for (const entry of planned) {
    const { installer, alias, sha256, size } = entry;
    const aliasPath = join(distDir, alias);
    copyFileSync(join(distDir, installer), aliasPath);
    // Hash what was actually written. A size check alone would let a
    // size-preserving bad copy through, and SHA256SUMS is the file a user runs
    // `sha256sum -c` against -- a line that does not describe its own bytes
    // reads as tampering. A second pass over 150 MB costs about a second on a
    // job that spends minutes signing. Report a length mismatch separately,
    // because that is the failure a truncated write actually produces.
    const copiedSize = statSync(aliasPath).size;
    if (copiedSize !== size) {
      throw new Error(
        `${alias} is ${copiedSize} bytes but ${installer} is ${size}; the copy did not complete`,
      );
    }
    entry.sha256 = digest(aliasPath);
    if (entry.sha256 !== sha256) {
      throw new Error(`${alias} does not match ${installer} after copying`);
    }
  }

  // Rewrite rather than append, so re-running the step cannot leave the alias
  // listed twice with two different digests.
  for (const { alias, sha256 } of planned) checksums.set(alias, sha256);
  writeChecksums(distDir, checksums);
  return planned;
}

// Invoked as a release-workflow step rather than from release.mjs: the alias has
// to be cut from the signed installer, which exists only once the signing job's
// packaging step has already returned. Takes the release stage -- the same
// directory release.mjs builds -- so the version comes from the packaged
// package.json instead of being restated in workflow YAML.
// Compare file URLs, not paths. This is the first script here that runs its CLI
// guard on Windows, where `process.argv[1]` carries whatever separators and
// drive-letter casing the shell supplied while `import.meta.url` is normalized;
// comparing resolved paths (assemble-mac-release.mjs, macOS only) can miss, and
// a guard that misses makes this script exit 0 having cut no alias. dev.mjs uses
// this spelling for the same reason.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stage = process.argv[2];
  if (!stage) {
    console.error("Usage: windows-release-artifacts.mjs <release-stage-dir>");
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
  const aliases = writeWindowsReleaseAliases(join(stage, "dist"), version);
  for (const { installer, alias } of aliases) {
    console.log(`  ${alias} <- ${installer}`);
  }
  // The workflow step that runs this treats a zero exit as "the alias shipped".
  // Say so explicitly so a future no-op cannot pass for success.
  console.log(`wrote ${aliases.length} stable Windows alias(es)`);
}
