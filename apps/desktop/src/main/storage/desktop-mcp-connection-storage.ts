import type { ThreadMcpConnectionSelectionStorage, ThreadSandboxStorage } from "@pwragent/owner-core/mcp-connection-storage";
import { getAppStateDb, getAppStateMode, getAppOverlayStore } from "../state/app-state";
import { ThreadSandboxStore } from "./thread-sandbox-store";

// Keep the event-time state guard and store construction at the gateway's
// existing lifecycle boundary; initialization and profile selection stay owned
// by application startup.
export function recordCreatedSandbox(params: Parameters<ThreadSandboxStorage["recordCreated"]>[0]): void {
  if (!getAppStateMode()) return;
  new ThreadSandboxStore(getAppStateDb().raw).recordCreated(params);
}

/**
 * The sandbox rows PwrAgent's Boat server reads and writes for one thread.
 * Each write is one commit, on a create, fork or delete, never per call.
 */
export const desktopThreadSandboxes: Pick<ThreadSandboxStorage, "recordCreated" | "pendingForThread" | "markOutcome"> = {
  recordCreated(params) {
    if (!getAppStateMode()) return false;
    return new ThreadSandboxStore(getAppStateDb().raw).recordCreated(params);
  },
  pendingForThread(params) {
    if (!getAppStateMode()) return [];
    return new ThreadSandboxStore(getAppStateDb().raw).pendingForThread(params);
  },
  markOutcome(params) {
    if (!getAppStateMode()) return;
    new ThreadSandboxStore(getAppStateDb().raw).markOutcome(params);
  },
};

export const desktopMcpConnectionSelectionStorage: ThreadMcpConnectionSelectionStorage = {
  async readSelection(context) {
    return (await getAppOverlayStore().getThreadOverlayState(context))?.mcpConnectionIds ?? [];
  },
};
