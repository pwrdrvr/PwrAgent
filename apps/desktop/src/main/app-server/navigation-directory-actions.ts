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
