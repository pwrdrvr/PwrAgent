import type { AppServerBackendKind } from "@pwragent/shared";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProfilePath, resolvePwragentRoot } from "../profile";

export type ThreadAssetOwner = { backend: AppServerBackendKind; threadId: string };

export function threadAssetRoot(owner?: ThreadAssetOwner): string {
  const root = resolveActiveProfilePath("state/thread-assets");
  return owner ? path.join(root, assetIdentitySegment(owner.backend), assetIdentitySegment(owner.threadId)) : root;
}

function assetIdentitySegment(value: string): string {
  if (!value) throw new Error("Thread asset identity cannot be empty.");
  const encoded = encodeURIComponent(value).replace(/\./g, "%2E");
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(encoded)
    ? `%${value.charCodeAt(0).toString(16)}${encoded.slice(1)}`
    : encoded;
}

export function isThreadAssetPath(filePath: string, owner?: ThreadAssetOwner): boolean {
  return isInsideRoot(filePath, threadAssetRoot(owner));
}

function isInsideRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, path.resolve(filePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function isResolvedThreadAssetPath(filePath: string): Promise<boolean> {
  const profiles = path.join(resolvePwragentRoot(), "profiles");
  const root = await realpath(profiles).catch(() => profiles);
  if (!isInsideRoot(filePath, root)) return false;
  const segments = path.relative(root, filePath).split(path.sep);
  return segments.length >= 6 && segments[1] === "state" && segments[2] === "thread-assets";
}

const operations = new Map<string, Promise<unknown>>();

export async function withAssetDirectory<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = operations.get(root);
  const pending = (async () => {
    await previous?.catch(() => undefined);
    return await action();
  })();
  operations.set(root, pending);
  try { return await pending; }
  finally { if (operations.get(root) === pending) operations.delete(root); }
}

async function withAssetOwner<T>(owner: ThreadAssetOwner, action: () => Promise<T>): Promise<T> {
  return await withAssetDirectory(threadAssetRoot(owner), action);
}

/** Owned assets are immutable. Replacement uses rename, never an in-place write to a shared inode. */
export async function storeThreadAsset(
  owner: ThreadAssetOwner,
  data: Buffer,
  name: string,
  sourcePath?: string,
  dependencies: { link?: typeof link; copyFile?: typeof copyFile } = {},
): Promise<string> {
  if (!name || path.basename(name) !== name || name === "." || name === ".." || name.includes("\\")) {
    throw new Error("Invalid thread asset filename.");
  }
  const digest = createHash("sha256").update(data).digest("hex");
  return await withAssetOwner(owner, async () => {
    const destination = path.join(threadAssetRoot(owner), digest, name);
    const existing = await lstat(destination).catch(() => undefined);
    if (existing?.isFile() && existing.size === data.byteLength) {
      const bytes = await readFile(destination);
      if (createHash("sha256").update(bytes).digest("hex") === digest) return destination;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.${randomUUID()}.tmp`;
    try {
      let shared = false;
      // External files and legacy caches can still be mutated by their owner;
      // only our immutable per-thread store is eligible for hardlink sharing.
      const canonicalSource = sourcePath ? await realpath(sourcePath) : undefined;
      if (canonicalSource && await isResolvedThreadAssetPath(canonicalSource)) {
        try {
          await (dependencies.link ?? link)(canonicalSource, temporaryPath);
          shared = true;
        } catch (error) {
          if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      if (!shared) {
        if (sourcePath) {
          await (dependencies.copyFile ?? copyFile)(sourcePath, temporaryPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        } else {
          await writeFile(temporaryPath, data, { flag: "wx" });
        }
      }
      // Validate the resulting file too: a mutable external source can change
      // between the initial read and the clone/copy.
      const copied = await readFile(temporaryPath);
      if (createHash("sha256").update(copied).digest("hex") !== digest) {
        throw new Error("Attachment changed while it was being retained.");
      }
      await rename(temporaryPath, destination);
      return destination;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  });
}

/** Resolve a previously promoted legacy path without reading or hashing its bytes again. */
export async function existingThreadAssetAlias(owner: ThreadAssetOwner, sourcePath: string): Promise<string | undefined> {
  const parent = path.basename(path.dirname(sourcePath));
  const digest = /^[a-f0-9]{64}$/iu.test(parent) ? parent : /^([a-f0-9]{64})\./iu.exec(path.basename(sourcePath))?.[1];
  if (!digest) return undefined;
  const destination = path.join(threadAssetRoot(owner), digest, path.basename(sourcePath));
  return (await lstat(destination).catch(() => undefined))?.isFile() ? destination : undefined;
}

/** Called only after permanent provider deletion; archiving keeps ownership. */
export async function deleteThreadAssets(owner: ThreadAssetOwner): Promise<void> {
  await withAssetOwner(owner, async () => {
    await rm(threadAssetRoot(owner), { recursive: true, force: true });
    // Match the existing preview cache's encoding, while refusing traversal
    // segments that encodeURIComponent leaves unchanged.
    const segments = [owner.backend, owner.threadId].map(encodeURIComponent);
    if (segments.every((segment) => segment && segment !== "." && segment !== "..")) {
      await rm(resolveActiveProfilePath(path.join("state", "thread-images", ...segments)), { recursive: true, force: true });
    }
  });
}
