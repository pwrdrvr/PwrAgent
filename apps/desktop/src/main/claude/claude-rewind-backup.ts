import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** The most file content one rewind keeps for its undo. */
export const CLAUDE_REWIND_BACKUP_LIMIT_BYTES = 50 * 1024 * 1024;

const MANIFEST = "manifest.json";

type BackupFile = {
  path: string;
  /** The file existed before the rewind; its contents are in `<index>`. */
  existed: boolean;
  /** SHA-256 of what the rewind left, or null when it left no file. */
  after?: string | null;
};

type BackupManifest = { files: BackupFile[] };

/**
 * Keep the current contents of the files a rewind is about to restore, so an
 * undo can put them back. Returns false, keeping nothing, when a file cannot
 * be read or the files exceed the limit: the rewind then cannot be undone.
 */
export async function backUpRewindFiles(
  directory: string,
  paths: readonly string[],
  limitBytes = CLAUDE_REWIND_BACKUP_LIMIT_BYTES,
): Promise<boolean> {
  const files: BackupFile[] = [];
  const contents: Buffer[] = [];
  let total = 0;
  try {
    for (const filePath of new Set(paths)) {
      const stats = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stats && !stats.isFile()) return false;
      total += stats?.size ?? 0;
      if (total > limitBytes) return false;
      files.push({ path: filePath, existed: Boolean(stats) });
      if (stats) contents.push(await readFile(filePath));
    }
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let index = 0;
    for (const file of files) {
      if (file.existed) await writeFile(path.join(directory, String(index)), contents[index++]!, { mode: 0o600 });
    }
    await writeManifest(directory, { files });
    return true;
  } catch {
    await rm(directory, { recursive: true, force: true });
    return false;
  }
}

/**
 * Record what the rewind left in each backed-up file. Returns false when the
 * rewind changed a file the backup does not hold.
 */
export async function recordRewoundFiles(directory: string, changed: readonly string[]): Promise<boolean> {
  const manifest = await readManifest(directory);
  const held = new Set(manifest.files.map((file) => file.path));
  if (changed.some((filePath) => !held.has(filePath))) return false;
  for (const file of manifest.files) file.after = await fileHash(file.path);
  await writeManifest(directory, manifest);
  return true;
}

/**
 * Put back the files as they were before the rewind. Refuses, changing
 * nothing, when a file changed after the rewind restored it.
 */
export async function restoreRewindFiles(directory: string): Promise<number> {
  const manifest = await readManifest(directory);
  for (const file of manifest.files) {
    if (file.after === undefined || await fileHash(file.path) !== file.after) {
      throw new Error(`${path.basename(file.path)} changed after the rewind, so PwrAgent cannot put it back.`);
    }
  }
  let index = 0;
  for (const file of manifest.files) {
    if (file.existed) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, await readFile(path.join(directory, String(index++))));
    } else {
      await rm(file.path, { force: true });
    }
  }
  return manifest.files.length;
}

async function fileHash(filePath: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readManifest(directory: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(path.join(directory, MANIFEST), "utf8")) as BackupManifest;
}

async function writeManifest(directory: string, manifest: BackupManifest): Promise<void> {
  await writeFile(path.join(directory, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
}
