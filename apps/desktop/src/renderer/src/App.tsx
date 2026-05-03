import { useState, type CSSProperties, type PointerEvent } from "react";
import { Sidebar } from "./features/navigation/Sidebar";
import { SettingsScreen } from "./features/settings/SettingsScreen";
import {
  useDesktopSettings,
  type DesktopSettingsState,
} from "./features/settings/useDesktopSettings";
import { ThreadView } from "./features/thread-detail/ThreadView";
import { useComposerDraftStore } from "./features/composer/useComposerDraftStore";
import { useBackendSummaries } from "./lib/useBackendSummaries";
import { useDesktopApi, type DesktopApi } from "./lib/desktop-api";
import { useRuntimeIdentity } from "./lib/runtime-identity";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { useThreadSessionState } from "./lib/useThreadSessionState";
import { useThreadSkills } from "./lib/useThreadSkills";

export function App() {
  const desktopApi = useDesktopApi();
  const settings = useDesktopSettings(desktopApi);

  if (desktopApi?.readSettings && !settings.snapshot) {
    return (
      <div className="app-shell app-shell--fatal-settings">
        <main className="app-main">
          <SettingsScreen desktopApi={desktopApi} settings={settings} />
        </main>
      </div>
    );
  }

  if (settings.snapshot?.configError) {
    return (
      <div className="app-shell app-shell--fatal-settings">
        <main className="app-main">
          <SettingsScreen desktopApi={desktopApi} settings={settings} />
        </main>
      </div>
    );
  }

  return <DesktopAppShell desktopApi={desktopApi} settings={settings} />;
}

function DesktopAppShell(props: {
  desktopApi?: DesktopApi;
  settings: DesktopSettingsState;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(408);
  const [mainView, setMainView] = useState<"thread" | "settings">("thread");
  const desktopApi = props.desktopApi;
  const settings = props.settings;
  const runtimeIdentity = useRuntimeIdentity(desktopApi);
  const backendSummaries = useBackendSummaries(desktopApi);
  const navigation = useThreadNavigation(desktopApi);
  const composerDraftStore = useComposerDraftStore();
  const session = useThreadSessionState({
    desktopApi,
    thread: navigation.selectedThread,
  });
  const skills = useThreadSkills({
    desktopApi,
    launchpad: navigation.selectedLaunchpad,
    thread: navigation.selectedThread,
  });

  const resizeSidebar = (nextWidth: number): void => {
    setSidebarWidth(Math.min(560, Math.max(280, nextWidth)));
  };

  const startSidebarResize = (event: PointerEvent<HTMLElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const move = (moveEvent: globalThis.PointerEvent): void => {
      resizeSidebar(startWidth + moveEvent.clientX - startX);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <div
      className="app-shell"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
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
        runtimeIdentity={runtimeIdentity}
        launchpadError={navigation.launchpadError}
        loading={navigation.loading}
        approvalRequestThreadKeys={session.approvalRequestThreadKeys}
        selectedItemKey={navigation.selectedItemKey}
        thinkingThreadKeys={session.thinkingThreadKeys}
        threads={navigation.threads}
        settingsActive={mainView === "settings"}
        onBrowseModeChange={navigation.setBrowseMode}
        onCreateThread={navigation.createThread}
        onOpenLaunchpad={async (directory, preferredBackend) => {
          setMainView("thread");
          await navigation.openDirectoryLaunchpad(directory, preferredBackend);
        }}
        onOpenSettings={() => setMainView("settings")}
        onSelectThread={(thread) => {
          setMainView("thread");
          navigation.selectThread(thread);
        }}
        onArchiveThread={navigation.archiveThread}
        onRenameThread={navigation.renameThread}
        onResizeStart={startSidebarResize}
        onResizeByKeyboard={(delta) => resizeSidebar(sidebarWidth + delta)}
      />

      <main className="app-main">
        <ThreadView
          activeTurnId={session.activeTurnId}
          activeTurnStartedAt={session.activeTurnStartedAt}
          addOptimisticReviewEntry={session.addOptimisticReviewEntry}
          addOptimisticUserMessage={session.addOptimisticUserMessage}
          backendError={backendSummaries.error}
          backends={backendSummaries.backends}
          applications={settings.snapshot?.applications}
          clearPendingRequest={session.clearPendingRequest}
          composerDisabled={
            !navigation.selectedThread ||
            !backendSummaries.backends.some(
              (backend) =>
                backend.kind === navigation.selectedThread?.source &&
                backend.available
            )
          }
          composerImplementation={settings.composerImplementation}
          composerDraftStore={composerDraftStore}
          desktopApi={desktopApi}
          launchpadError={navigation.launchpadError}
          loading={session.loading}
          loadingMore={session.loadingMore}
          messageCount={session.messages.length}
          contextWindow={session.contextWindow}
          pendingAssistantMessage={session.pendingAssistantMessage}
          pendingMcpInteraction={session.pendingMcpInteraction}
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
          onHandoffThreadWorkspace={
            navigation.selectedThread
              ? async (request) =>
                  await navigation.handoffThreadWorkspace(
                    navigation.selectedThread!,
                    request
                  )
              : undefined
          }
          onLoadOlder={session.loadOlder}
          onLiveTranscriptEntry={session.upsertLiveTranscriptEntry}
          onMaterializeLaunchpad={navigation.materializeDirectoryLaunchpad}
          onPendingStatusChange={session.setPendingStatusText}
          onRefreshNavigation={navigation.refresh}
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
          onUpdatePendingMcpInteraction={session.updatePendingMcpInteraction}
          onUpdatePendingUserInput={session.updatePendingUserInput}
          removeOptimisticMessage={session.removeOptimisticMessage}
          transcriptViewport={session.viewport}
        />
      </main>

      {mainView === "settings" ? (
        <div className="app-shell__settings-layer">
          <SettingsScreen
            desktopApi={desktopApi}
            settings={settings}
            onClose={() => setMainView("thread")}
          />
        </div>
      ) : null}
    </div>
  );
}
