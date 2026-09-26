/**
 * Place an Electron-compatible better-sqlite3 binary in a separate directory
 * (electron-native/) so it can coexist with the system-Node binary.
 *
 * The app code uses the `nativeBinding` option to load from electron-native/
 * when running inside Electron, while unit tests use the default Node binary.
 *
 * better-sqlite3 publishes Electron prebuilds only for the Electron majors
 * that existed when its release was cut; 12.11.1 stops at ABI 146 (Electron
 * 42). When no prebuild matches the installed Electron, the binding is
 * compiled against that Electron's headers instead. A stamp beside the binary
 * records the Electron version it was made for, so moving to a new Electron
 * replaces a binary built for the old ABI instead of keeping it.
 */

import { execFileSync, execSync } from "node:child_process";
import {
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  cpSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
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
const targetStamp = join(electronNativeDir, "electron-target.txt");
const expectedStamp = `electron-v${electronVersion}-${process.platform}-${process.arch}`;
const defaultBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node");
const backupBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node.bak");

function readStamp() {
  return existsSync(targetStamp) ? readFileSync(targetStamp, "utf8").trim() : undefined;
}

/**
 * Fetch the published Electron prebuild. prebuild-install writes it over the
 * default binary, so the system-Node binary is set aside and restored.
 */
function downloadPrebuild() {
  console.log(`Downloading better-sqlite3 prebuild for Electron ${electronVersion}...`);

  if (existsSync(defaultBinary)) {
    copyFileSync(defaultBinary, backupBinary);
  }

  try {
    execSync(
      `${bin} --runtime=electron --target=${electronVersion} --arch=${process.arch} --tag-prefix=v --strip`,
      { cwd: betterSqlite3Dir, stdio: "inherit" }
    );
    copyFileSync(defaultBinary, targetBinary);
    return true;
  } catch (err) {
    console.log(`No better-sqlite3 prebuild for Electron ${electronVersion}: ${err.message}`);
    return false;
  } finally {
    if (existsSync(backupBinary)) {
      copyFileSync(backupBinary, defaultBinary);
      unlinkSync(backupBinary);
    }
  }
}

/**
 * Compile the binding against the installed Electron's headers. The build
 * runs in a scratch copy of the package because `node-gyp rebuild` starts by
 * deleting build/, which holds the system-Node binary unit tests load.
 */
function buildFromSource() {
  console.log(`Building better-sqlite3 from source for Electron ${electronVersion}...`);

  const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
  const buildRoot = mkdtempSync(join(tmpdir(), "pwragent-better-sqlite3-"));
  try {
    for (const entry of ["binding.gyp", "deps", "src"]) {
      cpSync(join(betterSqlite3Dir, entry), join(buildRoot, entry), { recursive: true });
    }
    execFileSync(
      process.execPath,
      [
        nodeGyp,
        "rebuild",
        "--release",
        `--target=${electronVersion}`,
        `--arch=${process.arch}`,
        "--dist-url=https://electronjs.org/headers",
        // The header cache @electron/rebuild uses, kept apart from Node's.
        `--devdir=${join(homedir(), ".electron-gyp")}`,
      ],
      { cwd: buildRoot, stdio: "inherit" }
    );
    copyFileSync(join(buildRoot, "build", "Release", "better_sqlite3.node"), targetBinary);
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}

ensureElectronRuntime();

if (existsSync(targetBinary) && readStamp() === expectedStamp) {
  console.log(`Electron native binary already built for Electron ${electronVersion}, skipping rebuild.`);
  process.exit(0);
}

rmSync(electronNativeDir, { recursive: true, force: true });
mkdirSync(electronNativeDir, { recursive: true });

try {
  if (!downloadPrebuild()) {
    buildFromSource();
  }
} catch (err) {
  rmSync(electronNativeDir, { recursive: true, force: true });
  console.error(`Failed to build better-sqlite3 for Electron ${electronVersion}:`, err.message);
  process.exit(1);
}

writeFileSync(targetStamp, `${expectedStamp}\n`);

console.log(`Electron native binary placed at ${targetBinary}`);
console.log(`Node native binary preserved at ${defaultBinary}`);
