import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

let resolvedBinding: string | undefined;

/**
 * Returns the path to the Electron-compatible better_sqlite3.node binary
 * when running inside Electron, or undefined to use the default Node binary.
 *
 * The rebuild script places the Electron prebuild at:
 *   <better-sqlite3>/electron-native/better_sqlite3.node
 *
 * The default binary at build/Release/ stays compiled for system Node,
 * so unit tests work without any rebuild step.
 */
export function getNativeBinding(): string | undefined {
  if (resolvedBinding !== undefined) return resolvedBinding || undefined;

  // Only redirect when running inside Electron
  if (!isElectron()) {
    resolvedBinding = "";
    return undefined;
  }

  const require = createRequire(import.meta.url);
  const betterSqlite3Dir = path.dirname(
    require.resolve("better-sqlite3/package.json"),
  );
  const electronNative = path.join(
    betterSqlite3Dir,
    "electron-native",
    "better_sqlite3.node",
  );

  if (fs.existsSync(electronNative)) {
    resolvedBinding = electronNative;
    return electronNative;
  }

  // No separate Electron binary found — fall through to default.
  // This works when the default binary happens to match (same ABI).
  resolvedBinding = "";
  return undefined;
}

function isElectron(): boolean {
  return "electron" in process.versions;
}
