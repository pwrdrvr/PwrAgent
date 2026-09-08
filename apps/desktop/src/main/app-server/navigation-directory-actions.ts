import { buildThreadIdentityKey, type MarkNavigationDirectorySeenRequest, type MarkNavigationDirectorySeenResponse } from "@pwragent/shared";
import type { RemoveNavigationDirectoryRequest, RemoveNavigationDirectoryResponse } from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { loadLocalNavigationQueryIndex } from "./navigation-query-source";

/** No renderer membership assertion authorizes removing a registration. */
export async function removeLocalNavigationDirectory(
  request: RemoveNavigationDirectoryRequest,
): Promise<RemoveNavigationDirectoryResponse> {
  if (typeof request.directoryKey !== "string" || !request.directoryKey.startsWith("directory:")) {
    throw new Error("Only a registered project directory can be removed.");
  }
  const registry = getDesktopBackendRegistry();
  let changedDuringRead = false;
  const unsubscribe = registry.onEvent(() => { changedDuringRead = true; });
  try {
    const index = await loadLocalNavigationQueryIndex({ callerReason: "remove-navigation-directory" });
    if (index.coverage && index.coverage.state !== "complete") throw new Error("Owner directory membership is still checking or unavailable. Try again after providers are ready.");
    if (changedDuringRead) throw new Error("Owner state changed during the directory check. Refresh navigation and try again.");
    const directory = index.directories.find((candidate) => candidate.key === request.directoryKey);
    if (directory && (directory.kind !== "directory" || directory.threadKeys.length > 0)) {
      throw new Error("This directory contains threads. Refresh navigation before removing it.");
    }
    await getDesktopOverlayStore().removeDirectoryRegistration({ directoryKey: request.directoryKey });
  } finally { unsubscribe(); }
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
  let changedCount = 0;
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
