import {
  buildThreadIdentityKey,
  type MarkNavigationDirectorySeenRequest,
  type MarkNavigationDirectorySeenResponse,
} from "@pwragent/shared/contracts/navigation";
import { directoryIncludesCheckout } from "@pwragent/shared/directory-navigation";
import {
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
} from "@pwragent/shared/navigation-query-events";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  ArchiveThreadRequest,
  ArchiveThreadResponse,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  RemoveNavigationDirectoryRequest,
  RemoveNavigationDirectoryResponse,
} from "@pwragent/shared/contracts/navigation";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { loadLocalNavigationQueryIndex } from "./navigation-query-source";

function directoryCheckChangeDescription(event: AgentEvent): string {
  const params = event.notification.params as { threadId?: unknown; thread?: { id?: unknown } } | undefined;
  const threadId = typeof params?.threadId === "string" ? params.threadId
    : typeof params?.thread?.id === "string" ? params.thread.id : undefined;
  const thread = threadId ? `, thread ${threadId}` : ", no thread ID in event";
  const instance = event.federationTarget?.scope === "remote" ? `, event instance ${event.federationTarget.instanceId}` : "";
  return `${event.backend}, ${event.notification.method}${thread}${instance}`;
}

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
  let checkoutProject = false;
  try {
    const index = await loadLocalNavigationQueryIndex({ callerReason: "remove-navigation-directory" });
    if (index.coverage && index.coverage.state !== "complete") throw new Error("Owner directory membership is still checking or unavailable. Try again after providers are ready.");
    if (changedDuringRead) throw new Error("Owner state changed during the directory check. Refresh navigation and try again.");
    if (Object.values(index.directoryCaseAliases ?? {}).some((aliases) => aliases.includes(request.directoryKey))) {
      throw new Error("This directory is shown under another spelling. Choose the project from Directories.");
    }
    const directory = index.directories.find((candidate) => directoryIncludesCheckout(candidate, request.directoryKey));
    if (directory && directory.key !== request.directoryKey) {
      throw new Error("This checkout belongs to a group. Choose the project from Directories.");
    }
    checkoutProject = Boolean(directory?.checkoutPaths);
    if (checkoutProject && !request.archiveThreads) {
      throw new Error("Use Project Checkouts to ungroup this project.");
    }
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
      const worktreeKeys = index.worktreeProjectAliases?.[request.directoryKey];
      const caseAliases = index.directoryCaseAliases?.[request.directoryKey];
      await getDesktopOverlayStore().removeDirectoryRegistration({
        directoryKey: request.directoryKey,
        worktreeKeys,
        caseAliasKeys: caseAliases,
      });
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
    if (checkoutProject) return { directoryKey: request.directoryKey, cleanup, registrationRetained: true };
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
  let changedDuringRead: string | undefined;
  const unsubscribe = registry.onEvent((event) => {
    const { method, params } = event.notification;
    const sourceMethod = method === "navigation/invalidated" ? params.sourceMethod : method;
    // Activity can advance updatedAt while we read; the captured watermark
    // leaves those newer updates unread. Only membership changes invalidate it.
    if (navigationQueryEventRequiresRefresh(method, params) && navigationInvalidationMayChangeMembership(sourceMethod)) {
      changedDuringRead ??= directoryCheckChangeDescription(event);
    }
  });
  let changedCount: number;
  try {
    const index = await loadLocalNavigationQueryIndex({ callerReason: "mark-navigation-directory-seen" });
    if (index.coverage && index.coverage.state !== "complete") throw new Error("Owner directory membership is still checking or unavailable. Try again after providers are ready.");
    if (changedDuringRead) {
      throw new Error(`Owner state changed during the directory check (${changedDuringRead}). Refresh navigation and try again.`);
    }
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
