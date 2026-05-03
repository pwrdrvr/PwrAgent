/**
 * Rebuild native modules (better-sqlite3) for the Electron runtime.
 *
 * During `pnpm install`, native modules are compiled for system Node. Electron
 * uses a different Node ABI, so we re-download the correct prebuild before
 * running E2E tests.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve the real path to better-sqlite3 (follows pnpm symlinks)
const betterSqlite3Dir = dirname(require.resolve("better-sqlite3/package.json"));

// Get the Electron version from the installed package
const electronPkg = require("electron/package.json");
const electronVersion = electronPkg.version;

// Find prebuild-install binary relative to better-sqlite3
const prebuildBin = resolve(betterSqlite3Dir, "node_modules", ".bin", "prebuild-install");
const prebuildFallback = resolve(betterSqlite3Dir, "..", "prebuild-install", "bin.js");

const bin = existsSync(prebuildBin) ? prebuildBin : `node ${prebuildFallback}`;

console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion}...`);
console.log(`  Package dir: ${betterSqlite3Dir}`);

try {
  execSync(
    `${bin} --runtime=electron --target=${electronVersion} --arch=${process.arch} --tag-prefix=v --strip`,
    { cwd: betterSqlite3Dir, stdio: "inherit" }
  );
  console.log("Native module rebuilt for Electron successfully.");
} catch (err) {
  console.error("prebuild-install failed, falling back to electron-rebuild...");
  // Fallback: try @electron/rebuild if prebuild-install fails
  try {
    execSync(
      `npx --yes @electron/rebuild -f -w better-sqlite3 -v ${electronVersion}`,
      { cwd: resolve(__dirname, ".."), stdio: "inherit" }
    );
    console.log("Native module rebuilt via electron-rebuild.");
  } catch (err2) {
    console.error("Failed to rebuild native module for Electron:", err2.message);
    process.exit(1);
  }
}
