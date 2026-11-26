import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type { ResearchChange } from "@pwragent/shared/research";
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
  const setThreadJobMonitorCreation = desktopApi.setThreadJobMonitorCreation;
  const openApplication = desktopApi.openApplication;
  const resolveTranscriptFiles = desktopApi.resolveTranscriptFiles;
  const readMarkdownFile = desktopApi.readMarkdownFile;
  const readUsageActivity = desktopApi.readUsageActivity;
  const openMarkdownFileViewer = desktopApi.openMarkdownFileViewer;
  const refreshDirectoryGitStatuses = desktopApi.refreshDirectoryGitStatuses;
  const readPwrSnapConnectionStatus = desktopApi.readPwrSnapConnectionStatus;
  const listMcpConnections = desktopApi.listMcpConnections;
  const readThreadMcpConnections = desktopApi.readThreadMcpConnections;
  const setThreadMcpConnections = desktopApi.setThreadMcpConnections;
  const describeThreadMcpConnections = desktopApi.describeThreadMcpConnections;
  const listWorktreeUnpublishedCommits =
    desktopApi.listWorktreeUnpublishedCommits;
  const getWorktreeUnpublishedCommitDiff =
    desktopApi.getWorktreeUnpublishedCommitDiff;
  const submitThreadReply = desktopApi.submitThreadReply;
  const searchResearch = desktopApi.searchResearch;
  const readResearchItem = desktopApi.readResearchItem;
  const updateResearchItem = desktopApi.updateResearchItem;
  const researchSnapshot = desktopApi.researchSnapshot;
  const researchChanges = desktopApi.researchChanges;
  const readResearchEvents = desktopApi.readResearchEvents;
  const researchHarnessStatus = desktopApi.researchHarnessStatus;
  const checkResearchHarness = desktopApi.checkResearchHarness;
  const reconcileResearchHarness = desktopApi.reconcileResearchHarness;
  const listMathosSwarms = desktopApi.listMathosSwarms;
  const startResearchHarness = desktopApi.startResearchHarness;
  const prepareResearch = desktopApi.prepareResearch;
  const withdrawResearch = desktopApi.withdrawResearch;
  const updateResearch = desktopApi.updateResearch;
  const onAgentEvent = desktopApi.onAgentEvent;

  return {
    ...desktopApi,
    setThreadAgent: setThreadAgent
      ? async (request) => await setThreadAgent({ ...request, federationTarget })
      : undefined,
    setThreadTokenMiser: setThreadTokenMiser
      ? async (request) => await setThreadTokenMiser({ ...request, federationTarget })
      : undefined,
    setThreadJobMonitorCreation: setThreadJobMonitorCreation
      ? async (request) => await setThreadJobMonitorCreation({ ...request, federationTarget })
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
    // Inventory and the saved selection must describe the same owner, even
    // when a caller relies on this scoped API rather than passing a target.
    listMcpConnections: listMcpConnections
      ? async (request) => await listMcpConnections({ ...request, federationTarget })
      : undefined,
    readThreadMcpConnections: readThreadMcpConnections
      ? async (request) => await readThreadMcpConnections({ ...request, federationTarget })
      : undefined,
    setThreadMcpConnections: setThreadMcpConnections
      ? async (request) => await setThreadMcpConnections({ ...request, federationTarget })
      : undefined,
    describeThreadMcpConnections: describeThreadMcpConnections
      ? async (request) => await describeThreadMcpConnections({ ...request, federationTarget })
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
    // The dashboard link signs in with the viewer's own CLI login.
    openSandboxerLink: undefined,
    // A Boat key is stored on the machine whose threads use it.
    connectBoat: undefined,
    startBoatSignIn: undefined,
    cancelBoatSignIn: undefined,
    openBoatSignInPage: undefined,
    listThreadBoatSandboxes: undefined,
    changeThreadBoatSandbox: undefined,
    setBoatSandboxPolicy: undefined,
    setBoatCleanupOnPrClose: undefined,
    openBoatLink: undefined,
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
    resolveTranscriptFiles: resolveTranscriptFiles
      ? async (request) => await resolveTranscriptFiles({ ...request, federationTarget })
      : undefined,
    readMarkdownFile: readMarkdownFile
      ? async (request) => await readMarkdownFile({ ...request, federationTarget })
      : undefined,
    // The Pricing rail's limit card is drawn from the owner's backends, so its
    // limit history and spend must come from the owner's ledger too. The
    // viewer's own ledger may hold no reading since a reset, or another account.
    readUsageActivity: readUsageActivity
      ? async (request) => await readUsageActivity({ ...request, federationTarget })
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
    // A peer's HTML preview shows without the files beside it: nothing on
    // the federation wire serves them.
    readHtmlPreviewAssets: undefined,
    readMarkdownFileViewerSnapshot: undefined,
    onMarkdownFileViewerSnapshotChanged: undefined,
    submitThreadReply: submitThreadReply
      ? async (request) => await submitThreadReply({ ...request, federationTarget })
      : undefined,
    // Research runs live on the thread's owning instance; route every
    // thread-scoped read and mutation there and follow its bus notifications.
    searchResearch: searchResearch
      ? async (request) => await searchResearch({ ...request, federationTarget })
      : undefined,
    readResearchItem: readResearchItem
      ? async (request) => await readResearchItem({ ...request, federationTarget })
      : undefined,
    updateResearchItem: updateResearchItem
      ? async (request) => await updateResearchItem({ ...request, federationTarget })
      : undefined,
    researchSnapshot: researchSnapshot
      ? async (request) => await researchSnapshot({ ...request, federationTarget })
      : undefined,
    researchChanges: researchChanges
      ? async (request) => await researchChanges({ ...request, federationTarget })
      : undefined,
    readResearchEvents: readResearchEvents
      ? async (request) => await readResearchEvents({ ...request, federationTarget })
      : undefined,
    researchHarnessStatus: researchHarnessStatus
      ? async (request) => await researchHarnessStatus({ ...request, federationTarget })
      : undefined,
    checkResearchHarness: checkResearchHarness
      ? async (request) => await checkResearchHarness({ ...request, federationTarget })
      : undefined,
    reconcileResearchHarness: reconcileResearchHarness
      ? async (request) => await reconcileResearchHarness({ ...request, federationTarget })
      : undefined,
    listMathosSwarms: listMathosSwarms
      ? async (request) => await listMathosSwarms({ ...request, federationTarget })
      : undefined,
    startResearchHarness: startResearchHarness
      ? async (request) => await startResearchHarness({ ...request, federationTarget })
      : undefined,
    prepareResearch: prepareResearch
      ? async (request) => await prepareResearch({ ...request, federationTarget })
      : undefined,
    withdrawResearch: withdrawResearch
      ? async (request) => await withdrawResearch({ ...request, federationTarget })
      : undefined,
    updateResearch: updateResearch
      ? async (request) => await updateResearch({ ...request, federationTarget })
      : undefined,
    onResearchChanged: onAgentEvent
      ? (callback) => onAgentEvent((event) => {
          if (
            event.federationTarget?.scope === "remote"
            && event.federationTarget.instanceId === federationTarget.instanceId
            && event.notification.method === "thread/research/changed"
          ) {
            const params = event.notification.params as Partial<ResearchChange>;
            if (typeof params.backend === "string" && typeof params.threadId === "string") {
              callback({
                backend: params.backend,
                threadId: params.threadId,
                ...(typeof params.runId === "string" ? { runId: params.runId } : {}),
                ...(typeof params.revision === "number" ? { revision: params.revision } : {}),
              });
            }
          }
        })
      : undefined,
    // Evidence files, Harness settings, and the local profile Research window
    // stay on the owning machine only.
    openResearchEvidence: undefined,
    revealResearchHarnessConfig: undefined,
    checkResearchHarnessBridge: undefined,
    pickResearchHarnessBridge: undefined,
    listMathosTeams: undefined,
    researchProfileRuns: undefined,
    openResearchWindow: undefined,
  };
}
