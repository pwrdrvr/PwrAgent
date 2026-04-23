import { Sidebar } from "./features/navigation/Sidebar";
import { ThreadView } from "./features/thread-detail/ThreadView";
import { useBackendSummaries } from "./lib/useBackendSummaries";
import { useDesktopApi } from "./lib/desktop-api";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { useThreadSessionState } from "./lib/useThreadSessionState";
import { useThreadSkills } from "./lib/useThreadSkills";

export function App() {
  const desktopApi = useDesktopApi();
  const backendSummaries = useBackendSummaries(desktopApi);
  const navigation = useThreadNavigation(desktopApi);
  const session = useThreadSessionState({
    desktopApi,
    thread: navigation.selectedThread,
  });
  const skills = useThreadSkills({
    desktopApi,
    launchpad: navigation.selectedLaunchpad,
    thread: navigation.selectedThread,
  });

  return (
    <div className="app-shell">
      <Sidebar
        backends={backendSummaries.backends}
        browseMode={navigation.browseMode}
        createThreadError={navigation.createThreadError}
        creatingThread={navigation.creatingThread}
        directories={navigation.directories}
        error={navigation.error}
        inboxThreads={navigation.inboxThreads}
        archiveThreadError={navigation.archiveThreadError}
        renameThreadError={navigation.renameThreadError}
        launchpadError={navigation.launchpadError}
        loading={navigation.loading}
        selectedItemKey={navigation.selectedItemKey}
        thinkingThreadKeys={session.thinkingThreadKeys}
        threads={navigation.threads}
        onBrowseModeChange={navigation.setBrowseMode}
        onCreateThread={navigation.createThread}
        onOpenLaunchpad={navigation.openDirectoryLaunchpad}
        onSelectThread={navigation.selectThread}
        onArchiveThread={navigation.archiveThread}
        onRenameThread={navigation.renameThread}
      />

      <main className="app-main">
        <ThreadView
          activeTurnId={session.activeTurnId}
          activeTurnStartedAt={session.activeTurnStartedAt}
          addOptimisticReviewEntry={session.addOptimisticReviewEntry}
          addOptimisticUserMessage={session.addOptimisticUserMessage}
          backendError={backendSummaries.error}
          backends={backendSummaries.backends}
          clearPendingRequest={session.clearPendingRequest}
          composerDisabled={
            !navigation.selectedThread ||
            !backendSummaries.backends.some(
              (backend) =>
                backend.kind === navigation.selectedThread?.source &&
                backend.available
            )
          }
          desktopApi={desktopApi}
          launchpadError={navigation.launchpadError}
          loading={session.loading}
          loadingMore={session.loadingMore}
          messageCount={session.messages.length}
          pendingAssistantMessage={session.pendingAssistantMessage}
          pendingRequest={session.pendingRequest}
          pendingUserInput={session.pendingUserInput}
          pendingStatusText={session.pendingStatusText}
          platform={desktopApi?.platform}
          selectedDirectory={navigation.selectedDirectory}
          selectedLaunchpad={navigation.selectedLaunchpad}
          selectedThread={navigation.selectedThread}
          setExecutionModeError={navigation.setThreadExecutionModeError}
          setThreadModelSettingsError={navigation.setThreadModelSettingsError}
          skillError={skills.error}
          skillLoading={skills.loading}
          skills={skills.skills}
          transcriptEntries={session.entries}
          transcriptError={session.error}
          transcriptPagination={session.response?.replay.pagination}
          updatingExecutionMode={navigation.updatingThreadExecutionMode}
          worktreeArchiveError={navigation.worktreeArchiveError}
          onActiveTurnIdChange={session.setActiveTurnId}
          onArchiveWorktree={navigation.archiveWorktree}
          onEnsureSkillsLoaded={skills.ensureLoaded}
          onLoadOlder={session.loadOlder}
          onMaterializeLaunchpad={navigation.materializeDirectoryLaunchpad}
          onPendingStatusChange={session.setPendingStatusText}
          onSetExecutionMode={
            navigation.selectedThread
              ? async (executionMode) =>
                  await navigation.setThreadExecutionMode(
                    navigation.selectedThread!,
                    executionMode
                  )
              : undefined
          }
          onSetThreadModelSettings={
            navigation.selectedThread
              ? async (patch) =>
                  await navigation.setThreadModelSettings(
                    navigation.selectedThread!,
                    patch
                  )
              : undefined
          }
          onRestoreWorktree={navigation.restoreWorktree}
          onTranscriptViewportChange={session.setViewport}
          onUpdateLaunchpad={navigation.updateDirectoryLaunchpad}
          onUpdatePendingUserInput={session.updatePendingUserInput}
          removeOptimisticMessage={session.removeOptimisticMessage}
          transcriptViewport={session.viewport}
        />
      </main>
    </div>
  );
}
