import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";

/** Rediscover models after changing the executable, then refresh cache consumers. */
export async function refreshManagedCodexModelCatalog(
  desktopApi: Pick<DesktopApi, "listBackends"> | undefined,
) {
  if (!desktopApi?.listBackends) {
    throw new Error("Provider model discovery is unavailable in this build.");
  }
  await desktopApi.listBackends({
    includeUnavailable: true,
    refreshModels: "codex",
    discoveryIntent: "settings-user-action",
  });
  window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
}

/** Shared Settings action, called only by an explicit update/check gesture. */
export async function checkForManagedCodexUpdates(
  desktopApi: Pick<DesktopApi, "refreshCodexDiscovery" | "listBackends"> | undefined,
  /** Settings can skip model discovery when its verified version is unchanged. */
  previousVersion?: string,
) {
  if (!desktopApi?.refreshCodexDiscovery) {
    throw new Error("Managed Codex release checks are unavailable in this build.");
  }
  const response = await desktopApi.refreshCodexDiscovery({
    discoveryIntent: "settings-user-action",
  });
  const updatedVersion = response.snapshot.runtime?.tokenMiser?.managedCodex?.version;
  if (
    previousVersion === undefined
    || (updatedVersion !== undefined && updatedVersion !== previousVersion)
  ) {
    await refreshManagedCodexModelCatalog(desktopApi);
  } else {
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  }
  return response;
}
