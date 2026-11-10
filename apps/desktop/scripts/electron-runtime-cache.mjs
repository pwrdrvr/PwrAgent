import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";

const FORMAT = 1;
const MANIFEST = "runtime.json";

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function platformPath(platform) {
  switch (platform) {
    case "mas":
    case "darwin": return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux": return "electron";
    case "win32": return "electron.exe";
    default: throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

// Hash directories, modes and link targets as well as bytes. Do not follow
// symlinks: macOS frameworks contain relative links inside the runtime.
export async function inventory(root, dir = root) {
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    const entry = { path: relative(root, path), mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) {
      entry.link = readlinkSync(path);
      const rel = relative(root, resolve(dirname(path), entry.link));
      if (isAbsolute(entry.link) || rel === ".." || rel.startsWith(`..${sep}`)) {
        throw new Error(`Electron runtime link escapes its dist: ${entry.path}`);
      }
    } else if (stat.isFile()) {
      entry.sha256 = await sha256File(path);
    } else if (stat.isDirectory()) {
      entry.directory = true;
    } else {
      throw new Error(`Unsupported Electron runtime entry: ${entry.path}`);
    }
    entries.push(entry);
    if (stat.isDirectory()) entries.push(...await inventory(root, path));
  }
  return entries;
}

async function verified(dir, identity) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    return JSON.stringify(manifest.identity) === JSON.stringify(identity)
      && JSON.stringify(manifest.files) === JSON.stringify(await inventory(join(dir, "dist")));
  } catch {
    return false;
  }
}

// Node's COPYFILE_FICLONE is silently ignored on macOS by libuv. Use the
// native clonefile-backed cp there; the APFS oracle pins real block sharing.
// Request CoW on other reflink filesystems, with independent-copy fallback.
// Never hard-link runtime files or symlink a worktree to a donor directory.
export function cloneTree(source, destination) {
  if (process.platform === "darwin") {
    try {
      execFileSync("/bin/cp", ["-cRpP", source, destination], { stdio: "pipe" });
      return;
    } catch {
      rmSync(destination, { recursive: true, force: true });
    }
  }
  cpSync(source, destination, {
    recursive: true, dereference: false, verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

function atomicWrite(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

// Publish a nonempty lock directory atomically. Dead-owner recovery unlinks
// only that owner's token, then removes an empty directory. It cannot delete
// a new owner's nonempty lock, even with simultaneous stale-lock recovery.
async function acquireInstallLock(electronDir) {
  const lock = join(electronDir, ".pwragent-runtime-lock");
  const token = `${process.pid}-${randomUUID()}`;
  const candidate = mkdtempSync(join(electronDir, ".runtime-lock-"));
  writeFileSync(join(candidate, token), "");
  const deadline = Date.now() + 120_000;
  try {
    for (;;) {
      try {
        renameSync(candidate, lock);
        return () => {
          unlinkSync(join(lock, token));
          try { rmdirSync(lock); } catch (error) {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
          }
        };
      } catch (error) {
        if (!existsSync(lock) && !["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(error.code)) throw error;
      }
      try {
        for (const owner of readdirSync(lock)) {
          const match = /^(\d+)-[a-f0-9-]+$/.exec(owner);
          if (!match) continue;
          try { process.kill(Number(match[1]), 0); } catch (error) {
            if (error.code !== "ESRCH") continue;
            try { unlinkSync(join(lock, owner)); } catch (unlinkError) {
              if (unlinkError.code !== "ENOENT") throw unlinkError;
            }
          }
        }
        try { rmdirSync(lock); } catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Electron installer lock: ${lock}`);
      await setTimeout(50);
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

export function extractZip(zipPath, targetDir) {
  const quotePowerShell = (value) => `'${value.replace(/'/g, "''")}'`;
  const attempts = process.platform === "win32"
    ? [
        ["powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(targetDir)} -Force`]],
        ["tar.exe", ["-xf", zipPath, "-C", targetDir]],
      ]
    : [["unzip", ["-q", "-o", zipPath, "-d", targetDir]], ["bsdtar", ["-xf", zipPath, "-C", targetDir]]];
  const errors = [];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { stdio: "pipe" });
      return;
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir);
    }
  }
  throw new Error(`Unable to extract Electron runtime artifact:\n${errors.join("\n")}`);
}

export async function ensureRuntime({ electronDir, version, platform, arch, cacheRoot, download, expectedChecksum, log = console.log }) {
  const executable = platformPath(platform);
  const target = { format: FORMAT, version, platform, arch };
  const installedManifest = join(electronDir, ".pwragent-runtime.json");
  const release = await acquireInstallLock(electronDir);
  let cacheStage;
  let installStage;
  try {
    // Completed installs require neither network nor cache access. A changed
    // target (including architecture) cannot pass this short circuit.
    try {
      const installed = JSON.parse(readFileSync(installedManifest, "utf8"));
      const types = installed.files.find((file) => file.path === "electron.d.ts");
      if (JSON.stringify(installed.target) === JSON.stringify(target)
        && (!expectedChecksum || installed.checksum === expectedChecksum)
        && (!types || types.sha256 === await sha256File(join(electronDir, "electron.d.ts")))
        && existsSync(join(electronDir, "dist", executable))
        && readFileSync(join(electronDir, "path.txt"), "utf8") === executable
        && JSON.stringify(installed.files) === JSON.stringify(await inventory(join(electronDir, "dist")))) return;
    } catch { /* Incomplete or legacy install: publish a verified replacement. */ }

    const zipPath = await download(); // @electron/get verifies cached ZIPs too.
    const checksum = await sha256File(zipPath);
    if (expectedChecksum && checksum !== expectedChecksum) throw new Error("Electron artifact checksum mismatch");
    const identity = { ...target, checksum };
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const entry = join(cacheRoot, key);
    let source;
    if (await verified(entry, identity)) {
      source = entry;
    } else {
      // Cache availability must not become an installation prerequisite.
      try {
        mkdirSync(cacheRoot, { recursive: true });
        cacheStage = mkdtempSync(join(cacheRoot, ".extract-"));
      } catch (error) {
        log(`Electron extraction cache unavailable (${error.message}); extracting locally.`);
        cacheStage = mkdtempSync(join(electronDir, ".extract-"));
      }
      mkdirSync(join(cacheStage, "dist"));
      extractZip(zipPath, join(cacheStage, "dist"));
      if (!existsSync(join(cacheStage, "dist", executable))
        || readFileSync(join(cacheStage, "dist/version"), "utf8").trim() !== version) {
        throw new Error("Electron artifact has an unexpected runtime version or executable");
      }
      const files = await inventory(join(cacheStage, "dist"));
      writeFileSync(join(cacheStage, MANIFEST), JSON.stringify({ identity, files }));
      source = cacheStage;
      try {
        renameSync(cacheStage, entry);
        cacheStage = undefined;
        source = entry;
      } catch (error) {
        // A simultaneous publisher wins. Clone the winner to share its blocks.
        if (await verified(entry, identity)) source = entry;
        else log(`Electron extraction cache not published (${error.message}); using verified local extraction.`);
        // Preserve invalid existing entries for diagnosis; never evict here.
      }
    }
    installStage = mkdtempSync(join(electronDir, ".runtime-install-"));
    cloneTree(join(source, "dist"), join(installStage, "dist"));
    const manifest = JSON.parse(readFileSync(join(source, MANIFEST), "utf8"));
    if (JSON.stringify(manifest.files) !== JSON.stringify(await inventory(join(installStage, "dist")))) {
      throw new Error("Electron runtime copy failed integrity verification");
    }
    const types = join(installStage, "dist/electron.d.ts");
    if (existsSync(types)) {
      cloneTree(types, join(installStage, "electron.d.ts"));
      renameSync(join(installStage, "electron.d.ts"), join(electronDir, "electron.d.ts"));
    }
    const dist = join(electronDir, "dist");
    const backup = join(installStage, "previous-dist");
    const hadDist = existsSync(dist);
    if (hadDist) renameSync(dist, backup);
    try {
      renameSync(join(installStage, "dist"), dist);
    } catch (error) {
      if (hadDist) renameSync(backup, dist);
      throw error;
    }
    atomicWrite(installedManifest, JSON.stringify({ target, checksum, files: manifest.files }));
    atomicWrite(join(electronDir, "path.txt"), executable);
    log(`Electron ${version} (${platform}/${arch}) runtime installed at ${join(dist, executable)}`);
  } finally {
    if (installStage) rmSync(installStage, { recursive: true, force: true });
    if (cacheStage) rmSync(cacheStage, { recursive: true, force: true });
    release();
  }
}
