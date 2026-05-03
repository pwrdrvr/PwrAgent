/**
 * Download the Electron-compatible better-sqlite3 prebuild into a separate
 * directory (electron-native/) so it can coexist with the system-Node binary.
 *
 * The app code uses the `nativeBinding` option to load from electron-native/
 * when running inside Electron, while unit tests use the default Node binary.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const betterSqlite3Dir = dirname(require.resolve("better-sqlite3/package.json"));
const electronPkg = require("electron/package.json");
const electronVersion = electronPkg.version;

const prebuildBin = resolve(betterSqlite3Dir, "node_modules", ".bin", "prebuild-install");
const prebuildFallback = resolve(betterSqlite3Dir, "..", "prebuild-install", "bin.js");
const bin = existsSync(prebuildBin) ? prebuildBin : `node ${prebuildFallback}`;

const electronNativeDir = join(betterSqlite3Dir, "electron-native");
const targetBinary = join(electronNativeDir, "better_sqlite3.node");
const defaultBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node");
const backupBinary = join(betterSqlite3Dir, "build", "Release", "better_sqlite3.node.bak");

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
