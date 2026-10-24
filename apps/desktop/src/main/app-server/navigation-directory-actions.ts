import { buildThreadIdentityKey, type MarkNavigationDirectorySeenRequest, type MarkNavigationDirectorySeenResponse } from "@pwragent/shared";
import type { ArchiveThreadRequest, ArchiveThreadResponse, RemoveNavigationDirectoryRequest, RemoveNavigationDirectoryResponse } from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { loadLocalNavigationQueryIndex } from "./navigation-query-source";

/** No renderer membership assertion authorizes removing a registration. */
export async function removeLocalNavigationDirectory(
  request: RemoveNavigationDirectoryRequest,
  archiveThread?: (request: ArchiveThreadRequest) => Promise<ArchiveThreadResponse | void>,
): Promise<RemoveNavigationDirectoryResponse> {
  const archiveWorkspace = request.archiveThreads === true && typeof request.directoryKey === "string" && request.directoryKey.startsWith("workspace:");
  if (typeof request.directoryKey !== "string" || (!request.directoryKey.startsWith("directory:") && !archiveWorkspace)) {
    throw new Error("Only a registered project directory can be removed.");
  }
  const registry = getDesktopBackendRegistry();
  let changedDuringRead = false;
  const unsubscribe = registry.onEvent(() => { changedDuringRead = true; });
  let members: ArchiveThreadRequest[] = [];
  try {
    const index = await loadLocalNavigationQueryIndex({ callerReason: "remove-navigation-directory" });
    if (index.coverage && index.coverage.state !== "complete") throw new Error("Owner directory membership is still checking or unavailable. Try again after providers are ready.");
    if (changedDuringRead) throw new Error("Owner state changed during the directory check. Refresh navigation and try again.");
    const directory = index.directories.find((candidate) => candidate.key === request.directoryKey);
    if (archiveWorkspace && directory?.kind !== "workspace") throw new Error("This workspace is no longer available on its owner.");
    if (request.archiveThreads && directory) {
      const keys = new Set(directory.threadKeys);
      const threads = new Map(index.threads.map((thread) => [buildThreadIdentityKey(thread.source, thread.id), thread]));
      members = [...keys].map((key) => {
        const thread = threads.get(key);
        if (!thread || thread.federation?.ref.target.scope === "remote") {
          throw new Error("Directory membership could not be resolved completely on this owner.");
        }
        return { backend: thread.source, threadId: thread.id };
      });
      if (members.length && !archiveThread) throw new Error("Directory archiving is unavailable on this instance.");
    }
    if (directory && ((!archiveWorkspace && directory.kind !== "directory") || (!request.archiveThreads && directory.threadKeys.length > 0))) {
      throw new Error("This directory contains threads. Refresh navigation before removing it.");
    }
    if (!request.archiveThreads) {
      await getDesktopOverlayStore().removeDirectoryRegistration({ directoryKey: request.directoryKey });
    }
  } finally { unsubscribe(); }
  if (request.archiveThreads) {
    const cleanup: ArchiveThreadResponse["cleanup"] = [];
    for (const member of members) {
      const response = await archiveThread!(member);
      cleanup.push(...(response?.cleanup ?? []));
    }
    // Workspaces is a permanent navigation group, not a project registration.
    if (archiveWorkspace) return { directoryKey: request.directoryKey, cleanup };
    // Archiving can race new threads. Never hide a directory that still owns work.
    const response = await removeLocalNavigationDirectory({ ...request, archiveThreads: false });
    return { ...response, cleanup };
  }
  await getDesktopBackendRegistry().publishLocalEvent({ backend: "codex", notification: {
    method: "navigation/directory/removed", params: { directoryKey: request.directoryKey },
  } });
  return { directoryKey: request.directoryKey };
}

/** Capture owner membership and seen watermarks together, before one atomic write. */
export async function markLocalNavigationDirectorySeen(
  request: MarkNavigationDirectorySeenRequest,
): Promise<MarkNavigationDirectorySeenResponse> {
  if (typeof request.directoryKey !== "string" || !request.directoryKey) throw new Error("A directory identity is required.");
  const registry = getDesktopBackendRegistry();
  let changedDuringRead = false;
  const unsubscribe = registry.onEvent(() => { changedDuringRead = true; });
  let changedCount: number;
  try {
    const index = await loadLocalNavigationQueryIndex({ callerReason: "mark-navigation-directory-seen" });
    if (index.coverage && index.coverage.state !== "complete") throw new Error("Owner directory membership is still checking or unavailable. Try again after providers are ready.");
    if (changedDuringRead) throw new Error("Owner state changed during the directory check. Refresh navigation and try again.");
    const directory = index.directories.find((candidate) => candidate.key === request.directoryKey);
    if (!directory) throw new Error("This directory is no longer available on its owner.");
    const keys = new Set(directory.threadKeys);
    const members = new Map(index.threads.filter((thread) => keys.has(buildThreadIdentityKey(thread.source, thread.id)))
      .map((thread) => [buildThreadIdentityKey(thread.source, thread.id), thread]));
    if ([...keys].some((key) => !members.has(key)) || [...members.values()].some((thread) => thread.federation?.ref.target.scope === "remote")) {
      throw new Error("Directory membership could not be resolved completely on this owner.");
    }
    changedCount = getDesktopOverlayStore().markNavigationThreadsSeen([...members.values()]
      .filter((thread) => thread.inbox.inInbox)
      .map((thread) => ({ backend: thread.source, threadId: thread.id, seenUpdatedAt: thread.updatedAt })));
  } finally { unsubscribe(); }
  const response = { directoryKey: request.directoryKey, changedCount };
  if (changedCount) await registry.publishLocalEvent({ backend: "codex", notification: {
    method: "navigation/directory/seen", params: response,
  } });
  return response;
}
