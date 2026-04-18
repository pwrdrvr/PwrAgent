import { useBackendSummaries } from "./lib/useBackendSummaries";
import { Sidebar } from "./features/navigation/Sidebar";
import { ThreadView } from "./features/thread-detail/ThreadView";
import { getDesktopApi } from "./lib/desktop-api";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { useThreadSkills } from "./lib/useThreadSkills";
import { useThreadTranscript } from "./lib/useThreadTranscript";

export function App() {
  const desktopApi = getDesktopApi();
  const backendSummaries = useBackendSummaries(desktopApi);
  const navigation = useThreadNavigation(desktopApi);
  const transcript = useThreadTranscript({
    desktopApi,
    thread: navigation.selectedThread
  });
  const skills = useThreadSkills({
    desktopApi,
    launchpad: navigation.selectedLaunchpad,
    thread: navigation.selectedThread,
  });

  return (
    <div className="app-shell">
      <Sidebar
        browseMode={navigation.browseMode}
        backends={backendSummaries.backends}
        createThreadError={navigation.createThreadError}
        directories={navigation.directories}
        error={navigation.error}
        fetchedAt={navigation.snapshot?.fetchedAt}
        inboxThreads={navigation.inboxThreads}
        launchpadError={navigation.launchpadError}
        loading={navigation.loading}
        creatingThread={navigation.creatingThread}
        refreshing={navigation.refreshing}
        selectedItemKey={navigation.selectedItemKey}
        threads={navigation.threads}
        onBrowseModeChange={navigation.setBrowseMode}
        onCreateThread={navigation.createThread}
        onOpenLaunchpad={navigation.openDirectoryLaunchpad}
        onRefresh={navigation.refresh}
        onSelectThread={navigation.selectThread}
      />

      <main className="app-main">
        <ThreadView
          addOptimisticUserMessage={transcript.addOptimisticUserMessage}
          backendError={backendSummaries.error}
          backends={backendSummaries.backends}
          fetchedAt={transcript.response?.fetchedAt}
          loading={transcript.loading}
          loadingMore={transcript.loadingMore}
          messageCount={transcript.messages.length}
          composerDisabled={
            !navigation.selectedThread ||
            !backendSummaries.backends.some(
              (backend) =>
                backend.kind === navigation.selectedThread?.source &&
                backend.available
            )
          }
          desktopApi={desktopApi}
          platform={desktopApi?.platform}
          selectedDirectory={navigation.selectedDirectory}
          selectedLaunchpad={navigation.selectedLaunchpad}
          selectedThread={navigation.selectedThread}
          setExecutionModeError={navigation.setThreadExecutionModeError}
          skillError={skills.error}
          skillLoading={skills.loading}
          skills={skills.skills}
          transcriptError={transcript.error}
          transcriptEntries={transcript.entries}
          transcriptPagination={transcript.response?.replay.pagination}
          updatingExecutionMode={navigation.updatingThreadExecutionMode}
          launchpadError={navigation.launchpadError}
          onLoadOlder={transcript.loadOlder}
          onMaterializeLaunchpad={navigation.materializeDirectoryLaunchpad}
          onSetExecutionMode={
            navigation.selectedThread
              ? async (executionMode) =>
                  await navigation.setThreadExecutionMode(
                    navigation.selectedThread!,
                    executionMode
                  )
              : undefined
          }
          onUpdateLaunchpad={navigation.updateDirectoryLaunchpad}
          removeOptimisticMessage={transcript.removeOptimisticMessage}
          onRefresh={
            navigation.selectedThread ? transcript.refresh : navigation.refresh
          }
        />
      </main>
    </div>
  );
}
