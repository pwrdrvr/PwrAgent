import type { FederationRemoteTarget } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export function scopeDesktopApiToFederationTarget(
  desktopApi: DesktopApi | undefined,
  federationTarget: FederationRemoteTarget | undefined,
): DesktopApi | undefined {
  if (!desktopApi || !federationTarget) {
    return desktopApi;
  }
  const openApplication = desktopApi.openApplication;
  const refreshDirectoryGitStatuses = desktopApi.refreshDirectoryGitStatuses;
  const readPwrSnapConnectionStatus = desktopApi.readPwrSnapConnectionStatus;
  const listWorktreeUnpublishedCommits =
    desktopApi.listWorktreeUnpublishedCommits;
  const getWorktreeUnpublishedCommitDiff =
    desktopApi.getWorktreeUnpublishedCommitDiff;

  return {
    ...desktopApi,
    openApplication: openApplication
      ? async (request) => await openApplication({
          ...request,
          federationTarget,
        })
      : undefined,
    refreshDirectoryGitStatuses: refreshDirectoryGitStatuses
      ? async (request) => await refreshDirectoryGitStatuses({
          ...request,
          federationTarget,
        })
      : undefined,
    readPwrSnapConnectionStatus: readPwrSnapConnectionStatus
      ? async () => await readPwrSnapConnectionStatus({ federationTarget })
      : undefined,
    listWorktreeUnpublishedCommits: listWorktreeUnpublishedCommits
      ? async (request) => await listWorktreeUnpublishedCommits({
          ...request,
          federationTarget,
        })
      : undefined,
    getWorktreeUnpublishedCommitDiff: getWorktreeUnpublishedCommitDiff
      ? async (request) => await getWorktreeUnpublishedCommitDiff({
          ...request,
          federationTarget,
        })
      : undefined,
    connectPwrSnap: undefined,
    openPwrSnap: undefined,
    openPwrSnapDownload: undefined,
    openPath: undefined,
    revealPath: undefined,
    readMarkdownFile: undefined,
    openMarkdownFileViewer: undefined,
    readMarkdownFileViewerSnapshot: undefined,
    onMarkdownFileViewerSnapshotChanged: undefined,
  };
}
