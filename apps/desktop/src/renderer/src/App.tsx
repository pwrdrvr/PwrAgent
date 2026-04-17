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
    thread: navigation.selectedThread,
  });

  return (
    <div className="app-shell">
      <Sidebar
        browseMode={navigation.browseMode}
        backends={backendSummaries.backends}
        createThreadError={navigation.createThreadError}
        error={navigation.error}
        fetchedAt={navigation.snapshot?.fetchedAt}
        inboxThreads={navigation.inboxThreads}
        loading={navigation.loading}
        creatingThread={navigation.creatingThread}
        refreshing={navigation.refreshing}
        selectedThreadKey={navigation.selectedThreadKey}
        threads={navigation.threads}
        onBrowseModeChange={navigation.setBrowseMode}
        onCreateThread={navigation.createThread}
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
          selectedThread={navigation.selectedThread}
          setExecutionModeError={navigation.setThreadExecutionModeError}
          skillError={skills.error}
          skillLoading={skills.loading}
          skills={skills.skills}
          transcriptError={transcript.error}
          transcriptEntries={transcript.entries}
          transcriptPagination={transcript.response?.replay.pagination}
          updatingExecutionMode={navigation.updatingThreadExecutionMode}
          onLoadOlder={transcript.loadOlder}
          onSetExecutionMode={
            navigation.selectedThread
              ? async (executionMode) =>
                  await navigation.setThreadExecutionMode(
                    navigation.selectedThread!,
                    executionMode
                  )
              : undefined
          }
          removeOptimisticMessage={transcript.removeOptimisticMessage}
          onRefresh={transcript.refresh}
        />
      </main>
    </div>
  );
}
