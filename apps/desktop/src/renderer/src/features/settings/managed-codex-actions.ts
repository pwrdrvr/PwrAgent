import type { DesktopApi } from "../../lib/desktop-api";

/** Shared Settings action, called only by an explicit update/check gesture. */
export async function checkForManagedCodexUpdates(
  desktopApi: Pick<DesktopApi, "refreshCodexDiscovery"> | undefined,
) {
  if (!desktopApi?.refreshCodexDiscovery) {
    throw new Error("Managed Codex release checks are unavailable in this build.");
  }
  return await desktopApi.refreshCodexDiscovery({
    discoveryIntent: "settings-user-action",
  });
}
