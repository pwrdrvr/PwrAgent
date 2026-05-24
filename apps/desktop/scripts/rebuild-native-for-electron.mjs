/**
 * Download the Electron-compatible better-sqlite3 prebuild into a separate
 * directory (electron-native/) so it can coexist with the system-Node binary.
 *
 * The app code uses the `nativeBinding` option to load from electron-native/
 * when running inside Electron, while unit tests use the default Node binary.
 */

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  readFileSync,
  renameSync
} from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const betterSqlite3Dir = dirname(require.resolve("better-sqlite3/package.json"));
const electronPackageJsonPath = require.resolve("electron/package.json");
const electronDir = dirname(electronPackageJsonPath);
const electronPkg = require(electronPackageJsonPath);
const electronVersion = electronPkg.version;

const prebuildBin = resolve(betterSqlite3Dir, "node_modules", ".bin", "prebuild-install");
const prebuildFallback = resolve(betterSqlite3Dir, "..", "prebuild-install", "bin.js");
const bin = existsSync(prebuildBin) ? prebuildBin : `node ${prebuildFallback}`;

const electronNativeDir = join(betterSqlite3Dir, "electron-native");
const targetBinary = join(electronNativeDir, "better_sqlite3.node");
const defaultBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node");
const backupBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node.bak");

await ensureElectronBinaryInstalled();

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

async function ensureElectronBinaryInstalled() {
  const platformPath = getElectronPlatformPath();
  const pathFile = join(electronDir, "path.txt");
  const executablePath = join(electronDir, "dist", platformPath);
  const frameworkPath = join(
    electronDir,
    "dist",
    "Electron.app",
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Electron Framework"
  );
  const requiredPaths = [executablePath];

  if (platformPath.startsWith("Electron.app/")) {
    requiredPaths.push(frameworkPath);
  }

  if (
    requiredPaths.every((requiredPath) => existsSync(requiredPath)) &&
    existsSync(pathFile) &&
    readFileSync(pathFile, "utf8") === platformPath
  ) {
    return;
  }

  console.log(`Installing Electron ${electronVersion} binary...`);

  const electronRequire = createRequire(join(electronDir, "index.js"));
  const { downloadArtifact } = electronRequire("@electron/get");
  const checksums = electronRequire("./checksums.json");
  const platform =
    process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
  const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;
  const distPath = join(electronDir, "dist");
  const zipPath = await downloadArtifact({
    version: electronVersion,
    artifactName: "electron",
    force: process.env.force_no_cache === "true",
    cacheRoot: process.env.electron_config_cache,
    checksums:
      process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
        ? undefined
        : checksums,
    platform,
    arch
  });

  await rm(distPath, { recursive: true, force: true });
  extractElectronZip(zipPath, distPath);

  const extractedTypes = join(distPath, "electron.d.ts");
  if (existsSync(extractedTypes)) {
    renameSync(extractedTypes, join(electronDir, "electron.d.ts"));
  }

  await writeFile(pathFile, platformPath);

  if (!existsSync(executablePath)) {
    throw new Error(`Electron binary install did not create ${executablePath}`);
  }
}

function extractElectronZip(zipPath, distPath) {
  // Use the host unzipper so postinstall/dev bootstrap waits for extraction.
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        zipPath,
        distPath
      ],
      { stdio: "inherit" }
    );
    return;
  }

  execFileSync("unzip", ["-q", zipPath, "-d", distPath], { stdio: "inherit" });
}

function getElectronPlatformPath() {
  const platform =
    process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;

  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}
