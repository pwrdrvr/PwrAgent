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

export const desktopMcpConnectionSelectionStorage: ThreadMcpConnectionSelectionStorage = {
  async readSelection(context) {
    return (await getAppOverlayStore().getThreadOverlayState(context))?.mcpConnectionIds ?? [];
  },
};
