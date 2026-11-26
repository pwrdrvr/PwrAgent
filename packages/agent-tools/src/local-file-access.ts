import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PRIVATE_STORAGE_DIRECTORIES = new Set([
  "archived_sessions",
  "rollouts",
  "sessions",
  // A PwrAgent profile keeps its database, runtime-instance markers, and
  // focus requests under `state/`. The root-file patterns below only match a
  // database sitting directly in the profile directory, which is not where the
  // app actually writes one.
  "state",
]);

const PRIVATE_STORAGE_ROOT_FILES = [
  /^history\.jsonl$/u,
  /^state(?:_[^.]+)?\.sqlite(?:-(?:shm|wal))?$/u,
  /^state\.db(?:-(?:shm|wal))?$/u,
];

export type ReadableLocalFilePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: "forbidden" | "not_found" };

export type WritableLocalFilePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: "forbidden" | "invalid" | "symlink" | "not_a_file" };

/**
 * Canonicalize a local path and refuse Codex/PwrAgent private storage.
 * When `allowedRoots` is provided, the resolved file must sit inside one of
 * those roots. Callers that omit `allowedRoots` keep the historical
 * inspect-anywhere-except-private-storage behavior.
 */
export async function resolveReadableLocalFilePath(
  filePath: string,
  options?: {
    allowedRoots?: readonly string[];
    privateStorageRoots?: readonly string[];
    deniedRoots?: readonly string[];
  },
): Promise<ReadableLocalFilePathResult> {
  const configuredRoots = configuredPrivateStorageRoots(
    options?.privateStorageRoots ?? [],
  );
  const deniedRoots = options?.deniedRoots ?? [];
  const denied = (file: string, roots: readonly string[]) => roots.some((root) => {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative === "" || isPathInsideRoot(relative);
  });
  if (isPrivateStoragePath(filePath, configuredRoots) || denied(filePath, deniedRoots)) {
    return { ok: false, reason: "forbidden" };
  }
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  const canonicalPrivateRoots = await canonicalizeRoots(configuredRoots);
  if (isPrivateStoragePath(resolvedPath, canonicalPrivateRoots)
    || denied(resolvedPath, await canonicalizeRoots(deniedRoots))) {
    return { ok: false, reason: "forbidden" };
  }
  if (options?.allowedRoots) {
    const canonicalAllowedRoots = await canonicalizeRoots(options.allowedRoots);
    const allowed = canonicalAllowedRoots.some((root) =>
      isPathInsideRoot(path.relative(root, resolvedPath)),
    );
    if (!allowed) {
      return { ok: false, reason: "forbidden" };
    }
  }
  return { ok: true, path: resolvedPath };
}

/**
 * Canonicalize a destination path for a new or overwritten local file,
 * refusing Codex/PwrAgent private storage, symlinks, non-file targets, and
 * anything outside `allowedRoots`. Missing parent directories are resolved
 * against their nearest existing ancestor so symlinked ancestors cannot escape
 * `allowedRoots`.
 */
export async function resolveWritableLocalFilePath(
  filePath: string,
  options: {
    allowedRoots: readonly string[];
    privateStorageRoots?: readonly string[];
    deniedRoots?: readonly string[];
  },
): Promise<WritableLocalFilePathResult> {
  if (!filePath.trim() || filePath.includes("\0") || !path.isAbsolute(filePath)) {
    return { ok: false, reason: "invalid" };
  }
  const configuredRoots = configuredPrivateStorageRoots(
    options.privateStorageRoots ?? [],
  );
  const deniedRoots = options.deniedRoots ?? [];
  const denied = (file: string, roots: readonly string[]) => roots.some((root) => {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative === "" || isPathInsideRoot(relative);
  });
  const resolvedPath = path.resolve(filePath);
  if (isPrivateStoragePath(resolvedPath, configuredRoots) || denied(resolvedPath, deniedRoots)) {
    return { ok: false, reason: "forbidden" };
  }
  if (options.allowedRoots.length === 0) {
    return { ok: false, reason: "forbidden" };
  }

  const targetStats = await lstat(resolvedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (targetStats) {
    if (targetStats.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!targetStats.isFile()) return { ok: false, reason: "not_a_file" };
  }

  const missingSegments: string[] = [];
  let cursor = path.dirname(resolvedPath);
  let canonicalAncestor: string | undefined;
  while (true) {
    const ancestorStats = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (ancestorStats) {
      if (!ancestorStats.isDirectory() && !ancestorStats.isSymbolicLink()) {
        return { ok: false, reason: "invalid" };
      }
      try {
        canonicalAncestor = await realpath(cursor);
      } catch {
        return { ok: false, reason: "invalid" };
      }
      const resolvedAncestorStats = await lstat(canonicalAncestor).catch(() => undefined);
      if (!resolvedAncestorStats?.isDirectory()) {
        return { ok: false, reason: "invalid" };
      }
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return { ok: false, reason: "invalid" };
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }

  const canonicalTarget = path.join(
    canonicalAncestor,
    ...missingSegments,
    path.basename(resolvedPath),
  );
  const canonicalPrivateRoots = await canonicalizeRoots(configuredRoots);
  if (isPrivateStoragePath(canonicalTarget, canonicalPrivateRoots)
    || denied(canonicalTarget, await canonicalizeRoots(deniedRoots))) {
    return { ok: false, reason: "forbidden" };
  }
  const canonicalAllowedRoots = await canonicalizeRoots(options.allowedRoots);
  const allowed = canonicalAllowedRoots.some((root) =>
    isPathInsideRoot(path.relative(root, canonicalTarget)),
  );
  if (!allowed) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, path: canonicalTarget };
}

async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  return await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
}

function configuredPrivateStorageRoots(
  privateStorageRoots: readonly string[],
): string[] {
  return [
    path.join(os.homedir(), ".codex"),
    process.env.CODEX_HOME?.trim(),
    ...privateStorageRoots,
  ].filter((root): root is string => Boolean(root));
}

function isPrivateStoragePath(
  filePath: string,
  privateStorageRoots: readonly string[],
): boolean {
  const resolvedPath = path.resolve(filePath);
  for (const root of privateStorageRoots) {
    const relativePath = path.relative(path.resolve(root), resolvedPath);
    if (
      isPathInsideRoot(relativePath)
      && isPrivateStorageRelativePath(relativePath)
    ) {
      return true;
    }
  }

  const components = resolvedPath.split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    if (components[index]?.toLowerCase() !== ".codex") {
      continue;
    }
    const relativePath = components.slice(index + 1).join(path.sep);
    if (isPrivateStorageRelativePath(relativePath)) {
      return true;
    }
  }
  return false;
}

function isPathInsideRoot(relativePath: string): boolean {
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function isPrivateStorageRelativePath(relativePath: string): boolean {
  let components = relativePath.split(path.sep).filter(Boolean);
  if (components[0]?.toLowerCase() === "profiles" && components.length >= 3) {
    components = components.slice(2);
  }
  const first = components[0]?.toLowerCase();
  if (!first || first === "worktrees") {
    return false;
  }
  if (PRIVATE_STORAGE_DIRECTORIES.has(first)) {
    return true;
  }
  return components.length === 1
    && PRIVATE_STORAGE_ROOT_FILES.some((pattern) => pattern.test(first));
}
