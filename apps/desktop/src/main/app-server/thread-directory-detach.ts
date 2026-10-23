import path from "node:path";
import type {
  AppServerBackendKind,
  DetachDirectoryFromThreadRequest,
  DetachDirectoryFromThreadResponse,
  LinkedDirectorySummary,
  AppServerThreadSummary,
} from "@pwragent/shared";
import type { SqliteOverlayStore } from "../state/overlay-store-sqlite";

function normalizeLinkedDirectoryPathForMatch(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed).replace(/\\/g, "/") : undefined;
}

function linkedDirectoriesMatchForDetach(
  left: Pick<LinkedDirectorySummary, "id" | "kind" | "path" | "worktreePath">,
  right: Pick<LinkedDirectorySummary, "id" | "kind" | "path" | "worktreePath">,
): boolean {
  if (left.id === right.id) {
    return true;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  return (
    normalizeLinkedDirectoryPathForMatch(left.path) ===
      normalizeLinkedDirectoryPathForMatch(right.path) &&
    normalizeLinkedDirectoryPathForMatch(left.worktreePath) ===
      normalizeLinkedDirectoryPathForMatch(right.worktreePath)
  );
}

function countDistinctLinkedDirectories(
  directories: LinkedDirectorySummary[],
): number {
  const seen = new Set<string>();
  for (const directory of directories) {
    const key = [
      directory.kind,
      normalizeLinkedDirectoryPathForMatch(directory.path),
      normalizeLinkedDirectoryPathForMatch(directory.worktreePath),
    ].join("\0");
    seen.add(key);
  }
  return seen.size;
}

/** Run on the thread owner so membership and path comparisons use its state. */
export async function detachOwnedThreadDirectory(
  request: DetachDirectoryFromThreadRequest,
  deps: {
    overlayStore: Pick<SqliteOverlayStore, "getThreadOverlayState" | "removeLinkedDirectory">;
    readThread: (backend: AppServerBackendKind, threadId: string) => Promise<Pick<AppServerThreadSummary, "linkedDirectories"> | undefined>;
    publishUpdate: (backend: AppServerBackendKind, threadId: string) => Promise<void>;
  },
): Promise<DetachDirectoryFromThreadResponse> {
  const backend = request.backend ?? "codex";
  const overlay = await deps.overlayStore.getThreadOverlayState({
    backend,
    threadId: request.threadId,
  });
  const currentDirectories = overlay?.extraLinkedDirectories ?? [];
  const matched = currentDirectories.find((directory) =>
    linkedDirectoriesMatchForDetach(directory, request.directory),
  );
  if (!matched) {
    return {
      ok: false,
      backend,
      threadId: request.threadId,
      reason: "primary-directory",
      message:
        "Only secondary directories attached to this thread can be detached.",
    };
  }
  const fullThread = await deps.readThread(backend, request.threadId)
    .catch(() => undefined);
  const totalLinkedDirectories = countDistinctLinkedDirectories([
    ...(fullThread?.linkedDirectories ?? []),
    ...currentDirectories,
  ]);
  if (totalLinkedDirectories <= 1) {
    return {
      ok: false,
      backend,
      threadId: request.threadId,
      reason: "last-directory",
      message:
        "Cannot detach the last linked directory from a thread.",
    };
  }

  const next = await deps.overlayStore.removeLinkedDirectory({
    backend,
    threadId: request.threadId,
    directory: matched,
  });

  await deps.publishUpdate(backend, request.threadId);

  return {
    ok: true,
    backend,
    threadId: request.threadId,
    directories: next.extraLinkedDirectories,
  };
}
