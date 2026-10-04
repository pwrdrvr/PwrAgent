import type { FederationRemoteTarget } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export function scopeDesktopApiToFederationTarget(
  desktopApi: DesktopApi | undefined,
  federationTarget: FederationRemoteTarget | undefined,
): DesktopApi | undefined {
  if (!desktopApi || !federationTarget) {
    return desktopApi;
  }
  const setThreadAgent = desktopApi.setThreadAgent;
  const setThreadTokenMiser = desktopApi.setThreadTokenMiser;
  const openApplication = desktopApi.openApplication;
  const readMarkdownFile = desktopApi.readMarkdownFile;
  const openMarkdownFileViewer = desktopApi.openMarkdownFileViewer;
  const refreshDirectoryGitStatuses = desktopApi.refreshDirectoryGitStatuses;
  const readPwrSnapConnectionStatus = desktopApi.readPwrSnapConnectionStatus;
  const listWorktreeUnpublishedCommits =
    desktopApi.listWorktreeUnpublishedCommits;
  const getWorktreeUnpublishedCommitDiff =
    desktopApi.getWorktreeUnpublishedCommitDiff;

  return {
    ...desktopApi,
    setThreadAgent: setThreadAgent
      ? async (request) => await setThreadAgent({ ...request, federationTarget })
      : undefined,
    setThreadTokenMiser: setThreadTokenMiser
      ? async (request) => await setThreadTokenMiser({ ...request, federationTarget })
      : undefined,
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
    // Image bytes come from the viewer's own disk; a remote thread's worktree
    // lives on its owner, so its rows keep the plain size chip.
    readWorktreeImage: undefined,
    connectPwrSnap: undefined,
    openPwrSnap: undefined,
    openPwrSnapDownload: undefined,
    // PwrGit has no federation surface yet: a remote thread must not read the
    // viewer's local PwrGit as if it were the owner's, and must not be able to
    // pair or launch anything on the viewer's machine for it.
    readPwrGitConnectionStatus: undefined,
    connectPwrGit: undefined,
    openPwrGit: undefined,
    openPwrGitDownload: undefined,
    // Installers download onto the viewer's machine, which is never where a
    // remote thread's tools run.
    readPwrSuiteInstaller: undefined,
    startPwrSuiteDownload: undefined,
    cancelPwrSuiteDownload: undefined,
    openPwrSuiteInstaller: undefined,
    revealPwrSuiteInstaller: undefined,
    onPwrSuiteInstaller: undefined,
    openPath: undefined,
    revealPath: undefined,
    readMarkdownFile: readMarkdownFile
      ? async (request) => await readMarkdownFile({ ...request, federationTarget })
      : undefined,
    openMarkdownFileViewer: openMarkdownFileViewer
      ? async (request) => await openMarkdownFileViewer({
          ...request,
          context: {
            ...request.context,
            key: request.context.federationTarget?.scope === "remote"
              && request.context.federationTarget.instanceId === federationTarget.instanceId
              ? request.context.key
              : `remote:${federationTarget.instanceId}:${request.context.key}`,
            federationTarget,
          },
        })
      : undefined,
    readMarkdownFileViewerSnapshot: undefined,
    onMarkdownFileViewerSnapshotChanged: undefined,
  };
}
