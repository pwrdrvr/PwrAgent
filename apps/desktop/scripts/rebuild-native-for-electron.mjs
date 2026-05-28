/**
 * Download the Electron-compatible better-sqlite3 prebuild into a separate
 * directory (electron-native/) so it can coexist with the system-Node binary.
 *
 * The app code uses the `nativeBinding` option to load from electron-native/
 * when running inside Electron, while unit tests use the default Node binary.
 */

import { execFileSync, execSync } from "node:child_process";
import {
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const betterSqlite3Dir = dirname(require.resolve("better-sqlite3/package.json"));
const electronDir = dirname(require.resolve("electron/package.json"));
const electronPkg = require("electron/package.json");
const electronVersion = electronPkg.version;

function getElectronPlatformPath() {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(
        `Electron builds are not available on platform: ${process.platform}`,
      );
  }
}

function getElectronArtifactPlatform() {
  return process.platform === "win32" ? "win32" : process.platform;
}

function findElectronArtifactZip() {
  const filename = `electron-v${electronVersion}-${getElectronArtifactPlatform()}-${process.arch}.zip`;
  const roots = [
    process.env.electron_config_cache,
    join(homedir(), ".cache", "electron"),
    join(homedir(), "Library", "Caches", "electron"),
  ].filter(Boolean);

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }

    const direct = join(root, filename);
    if (existsSync(direct)) {
      return direct;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = join(root, entry.name, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function ensureElectronRuntime() {
  const platformPath = getElectronPlatformPath();
  const distDir = join(electronDir, "dist");
  const binaryPath = join(electronDir, "dist", platformPath);
  const pathMarker = join(electronDir, "path.txt");
  const markerMatches =
    existsSync(pathMarker) && readFileSync(pathMarker, "utf8") === platformPath;

  if (existsSync(binaryPath) && markerMatches) {
    return;
  }

  console.log(
    `Ensuring Electron ${electronVersion} runtime binary is installed...`,
  );
  execFileSync(process.execPath, [join(electronDir, "install.js")], {
    cwd: electronDir,
    stdio: "inherit",
  });

  if (existsSync(binaryPath)) {
    return;
  }

  const artifactZip = findElectronArtifactZip();
  if (!artifactZip) {
    throw new Error(
      `Electron ${electronVersion} artifact zip was not found in cache`,
    );
  }

  console.log(`Extracting Electron runtime from ${artifactZip}...`);
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", artifactZip, "-d", distDir], {
    stdio: "inherit",
  });
  writeFileSync(pathMarker, platformPath);
}

const prebuildBin = resolve(betterSqlite3Dir, "node_modules", ".bin", "prebuild-install");
const prebuildFallback = resolve(betterSqlite3Dir, "..", "prebuild-install", "bin.js");
const bin = existsSync(prebuildBin) ? prebuildBin : `node ${prebuildFallback}`;

const electronNativeDir = join(betterSqlite3Dir, "electron-native");
const targetBinary = join(electronNativeDir, "better_sqlite3.node");
const defaultBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node");
const backupBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node.bak");

ensureElectronRuntime();

if (existsSync(targetBinary)) {
  console.log(`Electron native binary already exists, skipping rebuild.`);
  process.exit(0);
}

console.log(`Downloading better-sqlite3 prebuild for Electron ${electronVersion}...`);

// 1. Back up the current Node binary
if (existsSync(defaultBinary)) {
  copyFileSync(defaultBinary, backupBinary);
}

// 2. Download the Electron prebuild (overwrites the default binary)
try {
  execSync(
    `${bin} --runtime=electron --target=${electronVersion} --arch=${process.arch} --tag-prefix=v --strip`,
    { cwd: betterSqlite3Dir, stdio: "inherit" }
  );
} catch (err) {
  // Restore backup on failure
  if (existsSync(backupBinary)) {
    copyFileSync(backupBinary, defaultBinary);
    unlinkSync(backupBinary);
  }
  console.error("Failed to download Electron prebuild:", err.message);
  process.exit(1);
}

// 3. Move the Electron binary to electron-native/
mkdirSync(electronNativeDir, { recursive: true });
copyFileSync(defaultBinary, targetBinary);

// 4. Restore the Node binary
if (existsSync(backupBinary)) {
  copyFileSync(backupBinary, defaultBinary);
  unlinkSync(backupBinary);
}

console.log(`Electron native binary placed at ${targetBinary}`);
console.log(`Node native binary preserved at ${defaultBinary}`);
