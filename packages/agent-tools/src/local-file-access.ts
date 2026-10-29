import { realpath } from "node:fs/promises";
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
