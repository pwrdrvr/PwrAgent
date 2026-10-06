import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProfilePath } from "../profile";
import { withAssetDirectory } from "./thread-assets";

const LEGACY_ATTACHMENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastSweep: { stateRoot: string; at: number; pending: boolean; work: Promise<void> } | undefined;

/** Upload-triggered expiry of the two retired shared stores; never scans thread assets. */
export function scheduleLegacyAttachmentCleanup(): Promise<void> {
  const stateRoot = resolveActiveProfilePath("state");
  const now = Date.now();
  if (lastSweep?.stateRoot === stateRoot && (lastSweep.pending || now - lastSweep.at < SWEEP_INTERVAL_MS)) {
    return lastSweep.work;
  }
  const sweep = { stateRoot, at: now, pending: true, work: Promise.resolve() };
  lastSweep = sweep;
  const cutoff = now - LEGACY_ATTACHMENT_MAX_AGE_MS;
  sweep.work = Promise.all(["image-inputs", "turn-input-attachments"].map(
    (store) => cleanupLegacyStore(path.join(stateRoot, store), cutoff),
  )).then(() => undefined).catch(() => undefined).finally(() => { sweep.pending = false; });
  return sweep.work;
}

async function cleanupLegacyStore(root: string, cutoff: number): Promise<void> {
  // lstat refuses symlink/junction stores and buckets instead of following
  // them to paths outside this profile's legacy attachment directories.
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) return;
  const entries = await readdir(root).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    await withAssetDirectory(entryPath, async () => {
      const info = await lstat(entryPath).catch(() => undefined);
      if (info?.isFile()) {
        if (info.mtimeMs < cutoff) await unlink(entryPath).catch(() => undefined);
      } else if (info?.isDirectory()) {
        // Legacy layouts use one digest bucket level. Do not recurse into
        // unexpected directories, and judge each file's own last-write time.
        const children = await readdir(entryPath).catch(() => []);
        for (const child of children) {
          const filePath = path.join(entryPath, child);
          const file = await lstat(filePath).catch(() => undefined);
          if (file?.isFile() && file.mtimeMs < cutoff) await unlink(filePath).catch(() => undefined);
        }
        // A recent file, unexpected child, or concurrent writer keeps its
        // bucket. Never recursively delete a bucket based on directory age.
        await rmdir(entryPath).catch(() => undefined);
      }
    });
  }
}
