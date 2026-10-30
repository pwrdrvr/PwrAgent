import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProfilePath } from "../profile";
import { withAssetDirectory } from "../app-server/thread-assets";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MS = 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024 * 1024;
let lastSweep: { root: string; at: number; work: Promise<void> } | undefined;

/** Only the retired anonymous store. Project output is never scanned or expired. */
export function scheduleLegacyCiArtifactCleanup(): Promise<void> {
  const root = resolveActiveProfilePath("artifacts/ci");
  const now = Date.now();
  if (lastSweep?.root === root && now - lastSweep.at < RECENT_MS) return lastSweep.work;
  const work = withAssetDirectory(root, async () => { await cleanupLegacyCiArtifacts(root, now); }).catch(() => {});
  lastSweep = { root, at: now, work };
  return work;
}

export async function cleanupLegacyCiArtifacts(root: string, now: number) {
  const result = { removedFiles: 0, removedBytes: 0 };
  // Refuse symlink/junction stores at either legacy path component.
  if (!(await lstat(path.dirname(root)).catch(() => undefined))?.isDirectory()
    || !(await lstat(root).catch(() => undefined))?.isDirectory()) return result;
  const candidates: Array<{ directory: string; file: string; size: number; mtimeMs: number }> = [];
  for (const name of await readdir(root)) {
    if (!/^download-[a-z0-9]{6}$/i.test(name)) continue;
    const directory = path.join(root, name);
    const bucket = await lstat(directory).catch(() => undefined);
    if (!bucket?.isDirectory()) continue;
    const names = await readdir(directory).catch(() => []);
    if (!names.length && bucket.mtimeMs >= now - RECENT_MS) continue;
    if (names.some((name) => !["artifact.zip", "artifact.zip.partial"].includes(name))) continue;
    // The old writer used a partial file and atomic rename. Never touch a
    // bucket a recent writer could still be publishing into (30s HTTP bound).
    const partial = path.join(directory, "artifact.zip.partial");
    const partialInfo = await lstat(partial).catch(() => undefined);
    if (partialInfo && (!partialInfo.isFile() || partialInfo.mtimeMs >= now - MAX_AGE_MS)) continue;
    if (partialInfo) {
      await unlink(partial);
      result.removedFiles++;
      result.removedBytes += partialInfo.size;
    }
    const file = path.join(directory, "artifact.zip");
    const info = await lstat(file).catch(() => undefined);
    if (info?.isFile()) candidates.push({ directory, file, size: info.size, mtimeMs: info.mtimeMs });
    else await rmdir(directory).catch(() => {});
  }
  let total = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (candidate.mtimeMs >= now - MAX_AGE_MS && (total <= MAX_BYTES || candidate.mtimeMs >= now - RECENT_MS)) continue;
    // Recheck the exact file, not a recursive directory deletion. A concurrent
    // replacement or a new partial keeps the bucket and its current contents.
    if (await lstat(path.join(candidate.directory, "artifact.zip.partial")).catch(() => undefined)) continue;
    const info = await lstat(candidate.file).catch(() => undefined);
    if (!info?.isFile() || info.size !== candidate.size || info.mtimeMs !== candidate.mtimeMs) continue;
    await unlink(candidate.file);
    total -= candidate.size;
    result.removedFiles++;
    result.removedBytes += candidate.size;
    await rmdir(candidate.directory).catch(() => {});
  }
  return result;
}
