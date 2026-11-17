import path from "node:path";
import { pathToFileURL } from "node:url";

/** ESM accepts file URLs on every host; Windows drive paths are URL schemes. */
export function headlessExternalSpecifier(resolved, platform = process.platform) {
  const windows = platform === "win32";
  return (windows ? path.win32 : path.posix).isAbsolute(resolved)
    ? pathToFileURL(resolved, { windows }).href
    : resolved;
}
