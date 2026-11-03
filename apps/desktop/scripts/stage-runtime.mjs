#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PwrDrvr LLC.
// Shared by PwrAgent and PwrGit. A checked-in manifest pins both the archive
// and its sealed file inventory; app packaging never discovers a latest Git.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const teamRequirement = '=anchor apple generic and certificate leaf[subject.OU] = "T44CNHC4UH"';
const hash = (data) => createHash("sha256").update(data).digest("hex");
const checked = (command, args, options = {}) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, windowsHide: true, ...options });
  if (r.error || r.status !== 0) throw new Error(`${command} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout.trim();
};

export function readRuntimeManifest(path, platform, arch) {
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (m.consumer_sha256 !== hash(readFileSync(fileURLToPath(import.meta.url)))) {
    throw new Error("Custom Git consumer differs from the approved shared implementation");
  }
  const key = platform === "darwin" ? "darwin-universal" : `${platform}-${arch}`;
  const asset = m.assets?.[key];
  if (m.schema !== 1 || !/^[0-9a-f]{40}$/.test(m.source_revision ?? "")
      || !/^\d+\.\d+\.\d+-dev-pwrgit\.\d+$/.test(m.version ?? "")
      || !asset || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")
      || !/^[0-9a-f]{64}$/.test(asset.inventory_sha256 ?? "")) {
    throw new Error(`Unsupported or incomplete custom Git manifest for ${key}`);
  }
  const prefix = `https://github.com/huntharo/git/releases/download/v${m.version}/`;
  if (!asset.url?.startsWith(prefix) || /[?#]/.test(asset.url)) {
    throw new Error("Custom Git archive must use its immutable versioned release URL");
  }
  if (platform === "darwin" && (asset.team_id !== "T44CNHC4UH" || asset.notarized !== true)) {
    throw new Error("Custom macOS Git requires the approved notarized PwrDrvr payload");
  }
  return { manifest: m, asset, key };
}

export function verifyRuntime(root, pin, { requireSigned = true, probe = true } = {}) {
  root = realpathSync(root);
  const inventoryPath = join(root, "runtime-files.json");
  const inventoryBytes = readFileSync(inventoryPath);
  if (hash(inventoryBytes) !== pin.asset.inventory_sha256) throw new Error("Git inventory checksum mismatch");
  const expected = JSON.parse(inventoryBytes);
  const actual = {};
  const executables = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      if (rel === "runtime-files.json") continue;
      const s = lstatSync(path);
      if (s.isSymbolicLink()) {
        const resolved = relative(root, realpathSync(path));
        if (resolved === ".." || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
          throw new Error(`Git symlink escapes payload: ${rel}`);
        }
        actual[rel] = { link: readlinkSync(path) };
      } else if (s.isDirectory()) visit(path);
      else if (s.isFile()) {
        const bytes = readFileSync(path);
        actual[rel] = { sha256: hash(bytes), mode: s.mode & 0o7777 };
        if (["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(bytes.subarray(0, 4).toString("hex"))) executables.push(path);
      } else throw new Error(`Unexpected Git payload file: ${rel}`);
    }
  };
  visit(root);
  for (const [name, entry] of Object.entries(expected)) {
    const a = actual[name];
    if (!a || a.link !== entry.link || a.sha256 !== entry.sha256 || a.mode !== entry.mode) {
      throw new Error(`Packaged custom Git bytes, mode or link changed: ${name}`);
    }
  }
  if (Object.keys(actual).length !== Object.keys(expected).length) throw new Error("Custom Git file set changed");
  const m = JSON.parse(readFileSync(join(root, "pwrgit-build.json"), "utf8"));
  if (m.version !== pin.manifest.version || m.source_revision !== pin.manifest.source_revision
      || m.primary_sha1 !== "SHA1_DC") throw new Error("Custom Git source/version mismatch");
  if (pin.key === "darwin-universal") {
    if (m.architecture !== "universal" || executables.length === 0) throw new Error("Expected universal Git executables");
    if (requireSigned && (m.notarized !== true || m.signing !== "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)")) {
      throw new Error("Expected Developer ID signed and notarized custom Git");
    }
    for (const file of executables) {
      if (checked("/usr/bin/lipo", ["-archs", file]).split(/\s+/).sort().join(" ") !== "arm64 x86_64") {
        throw new Error(`Missing universal Git slice: ${file}`);
      }
      checked("/usr/bin/codesign", ["--verify", "--all-architectures", "--strict",
        ...(requireSigned ? ["--test-requirement", teamRequirement] : []), file]);
    }
  }
  if (probe) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GIT_|DYLD_|LD_)/.test(name)));
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_TERMINAL_PROMPT = "0";
    env.PATH = join(root, "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin";
    const git = join(root, "bin", "git");
    const buildOptions = checked(git, ["version", "--build-options"], { env }).split(/\r?\n/);
    if (!buildOptions.includes("SHA-1: SHA1_DC") || !buildOptions.includes(`built from commit: ${m.source_revision}`)) {
      throw new Error("Executable Git source revision or primary SHA1_DC protection changed");
    }
    if (checked(git, ["--version"], { env }) !== `git version ${m.version}`
        || checked(git, ["--exec-path"], { env }) !== join(root, "libexec", "git-core")
        || !checked(git, ["lfs", "version"], { env }).startsWith(`git-lfs/${m.lfs_version} `)) {
      throw new Error("Packaged custom Git, LFS or relocated helper resolution failed");
    }
  }
  return m;
}

export async function stageRuntime({ manifestPath, platform, arch, output, cache = join(tmpdir(), "pwrgit-runtime-cache") }) {
  const pin = readRuntimeManifest(manifestPath, platform, arch);
  if (existsSync(output)) {
    try { verifyRuntime(output, pin); return pin; } catch { /* Replace a stale stage atomically. */ }
  }
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const archive = join(cache, `${pin.asset.sha256}.tar.gz`);
  if (!existsSync(archive) || hash(readFileSync(archive)) !== pin.asset.sha256) {
    const response = await fetch(pin.asset.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Custom Git download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== pin.asset.sha256) throw new Error("Custom Git archive checksum mismatch");
    const partialDir = mkdtempSync(join(cache, ".download-"));
    try {
      const partial = join(partialDir, "archive");
      writeFileSync(partial, bytes, { mode: 0o600 });
      renameSync(partial, archive);
    } finally { rmSync(partialDir, { recursive: true, force: true }); }
  }
  // Extraction lives beside the destination so renames stay on one filesystem.
  mkdirSync(dirname(output), { recursive: true });
  const temp = mkdtempSync(join(dirname(output), ".pwrgit-stage-"));
  const staging = join(temp, "runtime");
  const previous = join(temp, "previous");
  mkdirSync(staging);
  try {
    checked("tar", ["-xzf", archive, "-C", staging]);
    verifyRuntime(staging, pin);
    if (existsSync(output)) renameSync(output, previous);
    try { renameSync(staging, output); }
    catch (error) { if (existsSync(previous)) renameSync(previous, output); throw error; }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return pin;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, platform, arch, output] = process.argv.slice(2);
  if (!manifestPath || !platform || !arch || !output) throw new Error("Usage: stage-runtime.mjs MANIFEST PLATFORM ARCH OUTPUT");
  await stageRuntime({ manifestPath, platform, arch, output: resolve(output) });
}
