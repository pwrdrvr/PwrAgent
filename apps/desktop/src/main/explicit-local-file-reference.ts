import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Decode the absolute target of a composer [@filename](path) reference. */
export function normalizeExplicitLocalFileReferencePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("file://")) {
    try { return path.resolve(fileURLToPath(trimmed)); }
    catch { return undefined; }
  }
  let decoded: string;
  try { decoded = decodeURIComponent(trimmed); }
  catch { decoded = trimmed; }
  const expanded = decoded === "~"
    ? homedir()
    : decoded.startsWith("~/")
      ? path.join(homedir(), decoded.slice(2))
      : decoded;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
}
