import { useBackendSummaries } from "./lib/useBackendSummaries";
import { Sidebar } from "./features/navigation/Sidebar";
import { ThreadView } from "./features/thread-detail/ThreadView";
import { getDesktopApi } from "./lib/desktop-api";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { useThreadTranscript } from "./lib/useThreadTranscript";

export function App() {
  const desktopApi = getDesktopApi();
  const backendSummaries = useBackendSummaries(desktopApi);
  const navigation = useThreadNavigation(desktopApi);
  const transcript = useThreadTranscript({
    desktopApi,
    threadId: navigation.selectedThread?.id
  });

  return (
    <div className="app-shell">
      <Sidebar
        browseMode={navigation.browseMode}
        error={navigation.error}
        fetchedAt={navigation.snapshot?.fetchedAt}
        inboxThreads={navigation.inboxThreads}
        loading={navigation.loading}
        refreshing={navigation.refreshing}
        selectedThreadId={navigation.selectedThread?.id}
        threads={navigation.threads}
        onBrowseModeChange={navigation.setBrowseMode}
        onRefresh={navigation.refresh}
        onSelectThread={navigation.selectThread}
      />

      <main className="app-main">
        <ThreadView
          backendError={backendSummaries.error}
          backends={backendSummaries.backends}
          fetchedAt={transcript.response?.fetchedAt}
          loading={transcript.loading}
          loadingMore={transcript.loadingMore}
          messageCount={transcript.messages.length}
          platform={desktopApi?.platform}
          selectedThread={navigation.selectedThread}
          transcriptError={transcript.error}
          transcriptEntries={transcript.entries}
          transcriptPagination={transcript.response?.replay.pagination}
          onLoadOlder={transcript.loadOlder}
          onRefresh={transcript.refresh}
        />
      </main>
    </div>
  );
}
