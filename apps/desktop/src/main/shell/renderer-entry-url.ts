import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where every window loads the renderer from (see `getRendererEntry`). */
export interface RendererEntry {
  kind: "url" | "file";
  value: string;
}

/**
 * True when `targetUrl` is the app's own renderer document.
 *
 * - From a dev server: any URL on the dev server's origin.
 * - From the bundle: exactly the bundled `index.html`. A hash or query is
 *   allowed, because windows pick their view with one. Any other `file:`
 *   document is not: it would load with the PwrAgent preload API exposed.
 */
export function isAppRendererUrl(
  targetUrl: string | undefined,
  entry: RendererEntry,
): boolean {
  if (!targetUrl) {
    return false;
  }
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }

  if (entry.kind === "url") {
    let dev: URL;
    try {
      dev = new URL(entry.value);
    } catch {
      return false;
    }
    // An opaque origin serializes as "null" and matches nothing real.
    return dev.origin !== "null" && target.origin === dev.origin;
  }

  if (target.protocol !== "file:") {
    return false;
  }
  let targetPath: string;
  try {
    // Throws on a remote host and on an encoded path separator.
    targetPath = fileURLToPath(target);
  } catch {
    return false;
  }
  return samePath(resolve(targetPath), resolve(entry.value));
}

function samePath(left: string, right: string): boolean {
  // Windows paths are case-insensitive, and Chromium can report the drive
  // letter in either case.
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
