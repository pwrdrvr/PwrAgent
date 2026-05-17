import {
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { Sidebar } from "./features/navigation/Sidebar";
import {
  SettingsScreen,
  type SettingsSection,
} from "./features/settings/SettingsScreen";
import {
  useDesktopSettings,
  type DesktopSettingsState,
} from "./features/settings/useDesktopSettings";
import type { ThreadViewProps } from "./features/thread-detail/ThreadView";
import { useComposerDraftStore } from "./features/composer/useComposerDraftStore";
import { useDurableComposerDraftStore } from "./features/composer/useDurableComposerDraftStore";
import { useBackendSummaries } from "./lib/useBackendSummaries";
import { useDesktopApi, type DesktopApi } from "./lib/desktop-api";
import { useRuntimeIdentity } from "./lib/runtime-identity";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { usePwrAgentProfiles } from "./lib/usePwrAgentProfiles";
import { usePullRequestRefresh } from "./features/pr-status/usePullRequestRefresh";
import { useThreadSessionState } from "./lib/useThreadSessionState";
import { useThreadSkills } from "./lib/useThreadSkills";
import { useQueuedTurnRelease } from "./lib/useQueuedTurnRelease";
import { AppUpdateBanner } from "./features/update/AppUpdateBanner";

export function App() {
  const desktopApi = useDesktopApi();
  const settings = useDesktopSettings(desktopApi);

  if (desktopApi?.readSettings && !settings.snapshot && settings.error) {
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
  // Initial section for SettingsScreen — non-undefined when navigation
  // came from a deep-link to a specific section. Resets when the user
  // switches mainView. The Messaging Activity surface is its own
  // dedicated BrowserWindow, NOT a settings section, so it never
  // appears through this slot.
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    SettingsSection | undefined
  >(undefined);
  const [threadViewReady, setThreadViewReady] = useState(false);
  const [ThreadViewComponent, setThreadViewComponent] =
    useState<ComponentType<ThreadViewProps>>();
  const desktopApi = props.desktopApi;
  // Spawning / focusing the Messaging Activity window is fire-and-forget
  // — see `apps/desktop/src/main/messaging-activity-window.ts`. The
  // main window stays where it was; the activity surface gets its own
  // OS window with its own lifecycle.
  const openMessagingActivityWindow = useCallback(() => {
    void desktopApi?.openMessagingActivityWindow?.();
  }, [desktopApi]);
  const settings = props.settings;
  const profiles = usePwrAgentProfiles(desktopApi);
  const runtimeIdentity = useRuntimeIdentity(desktopApi);
  const navigation = useThreadNavigation(desktopApi, {
    threadViewVisible: mainView === "thread",
  });
  const backendSummaries = useBackendSummaries(desktopApi);
  const pullRequests = usePullRequestRefresh({
    desktopApi,
    onRefreshNavigation: navigation.refresh,
    selectedThread: navigation.selectedThread,
  });
  const baseComposerDraftStore = useComposerDraftStore();
  const composerDraftStore = useDurableComposerDraftStore(
    baseComposerDraftStore,
    desktopApi,
  );
  useQueuedTurnRelease({
    backends: backendSummaries.backends,
    composerDraftStore,
    desktopApi,
    selectedThread: navigation.selectedThread,
    threads: navigation.threads,
  });
  useEffect(() => {
    if (threadViewReady || mainView !== "thread" || navigation.loading) {
      return;
    }

    let timeoutId: number | undefined;
    let secondFrameId: number | undefined;
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(() => {
          setThreadViewReady(true);
        }, 0);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrameId);
      if (secondFrameId !== undefined) {
        window.cancelAnimationFrame(secondFrameId);
      }
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [mainView, navigation.loading, threadViewReady]);
  useEffect(() => {
    if (!threadViewReady || ThreadViewComponent) {
      return;
    }

    let cancelled = false;
    void import("./features/thread-detail/ThreadView").then((module) => {
      if (!cancelled) {
        setThreadViewComponent(() => module.ThreadView);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [ThreadViewComponent, threadViewReady]);
  const loadThreadDetail = threadViewReady && mainView === "thread";
  const session = useThreadSessionState({
    desktopApi,
    thread: loadThreadDetail ? navigation.selectedThread : undefined,
  });
  const skills = useThreadSkills({
    desktopApi,
    launchpad: navigation.selectedLaunchpad,
    thread: loadThreadDetail ? navigation.selectedThread : undefined,
  });
  const threadViewProps = {
    activeTurnId: session.activeTurnId,
    activeTurnStartedAt: session.activeTurnStartedAt,
    addOptimisticReviewEntry: session.addOptimisticReviewEntry,
    addOptimisticUserMessage: session.addOptimisticUserMessage,
    backendError: backendSummaries.error,
    backends: backendSummaries.backends,
    applications: settings.snapshot?.applications,
    archiveThreadError: navigation.archiveThreadError,
    clearPendingRequest: session.clearPendingRequest,
    composerDisabled:
      !navigation.selectedThread ||
      !backendSummaries.backends.some(
        (backend) =>
          backend.kind === navigation.selectedThread?.source &&
          backend.available
      ),
    composerImplementation: settings.composerImplementation,
    composerDraftStore,
    desktopApi,
    launchpadError: navigation.launchpadError,
    loading: session.loading,
    loadingMore: session.loadingMore,
    messageCount: session.messages.length,
    contextWindow: session.contextWindow,
    pendingAssistantMessage: session.pendingAssistantMessage,
    pendingMcpInteraction: session.pendingMcpInteraction,
    pendingRequest: session.pendingRequest,
    pendingUserInput: session.pendingUserInput,
    pendingStatusText: session.pendingStatusText,
    pastedImageMaxPatches:
      settings.snapshot?.imageUploads.pastedImageMaxPatches.value,
    platform: desktopApi?.platform,
    selectedDirectory: navigation.selectedDirectory,
    selectedLaunchpad: navigation.selectedLaunchpad,
    selectedThread: navigation.selectedThread,
    suppressBranchDriftDialog: mainView === "settings",
    directories: navigation.directories,
    fullAccessRiskWarningDismissed:
      settings.snapshot?.experimental.fullAccessRiskWarningDismissed.value ?? false,
    pickDirectoryError: navigation.pickDirectoryError,
    pickingDirectory: navigation.pickingDirectory,
    onSelectDirectoryFromPicker: (directory) => {
      void navigation.openDirectoryLaunchpad(directory);
    },
    onPickAndRegisterDirectory: () => {
      void navigation.pickAndRegisterDirectory();
    },
    onClearPickDirectoryError: navigation.clearPickDirectoryError,
    setExecutionModeError: navigation.setThreadExecutionModeError,
    setThreadModelSettingsError: navigation.setThreadModelSettingsError,
    skillError: skills.error,
    skillLoading: skills.loading,
    skills: skills.skills,
    transcriptEntries: session.entries,
    transcriptError: session.error,
    transcriptPagination: session.response?.replay.pagination,
    updatingExecutionMode: navigation.updatingThreadExecutionMode,
    worktreeArchiveError: navigation.worktreeArchiveError,
    onActiveTurnIdChange: session.setActiveTurnId,
    onArchiveThread: navigation.archiveThread,
    onArchiveWorktree: navigation.archiveWorktree,
    onEnsureSkillsLoaded: skills.ensureLoaded,
    onDismissFullAccessRiskWarning: async () => {
      const saved = await settings.writeConfig({
        experimental: {
          fullAccessRiskWarningDismissed: true,
        },
      });
      if (!saved) {
        throw new Error("Could not save the Full Access warning preference.");
      }
    },
    onOpenMessagingActivity: openMessagingActivityWindow,
    onHandoffThreadWorkspace: navigation.selectedThread
      ? async (request) =>
          await navigation.handoffThreadWorkspace(
            navigation.selectedThread!,
            request
          )
      : undefined,
    onLoadOlder: session.loadOlder,
    onLiveTranscriptEntry: session.upsertLiveTranscriptEntry,
    onMaterializeLaunchpad: navigation.materializeDirectoryLaunchpad,
    onPendingStatusChange: session.setPendingStatusText,
    onRefreshNavigation: navigation.refresh,
    onSetExecutionMode: navigation.selectedThread
      ? async (executionMode) =>
          await navigation.setThreadExecutionMode(
            navigation.selectedThread!,
            executionMode
          )
      : undefined,
    onCancelExecutionModeQueue: navigation.selectedThread
      ? async () =>
          await navigation.cancelThreadExecutionModeQueue(navigation.selectedThread!)
      : undefined,
    onSetThreadModelSettings: navigation.selectedThread
      ? async (patch) =>
          await navigation.setThreadModelSettings(navigation.selectedThread!, patch)
      : undefined,
    onRestoreWorktree: navigation.restoreWorktree,
    onTranscriptViewportChange: session.setViewport,
    onUpdateLaunchpad: navigation.updateDirectoryLaunchpad,
    onUpdatePendingMcpInteraction: session.updatePendingMcpInteraction,
    onUpdatePendingUserInput: session.updatePendingUserInput,
    removeOptimisticMessage: session.removeOptimisticMessage,
    transcriptViewport: session.viewport,
  } satisfies ThreadViewProps;

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
        recentThreads={navigation.recentThreads}
        archiveThreadError={navigation.archiveThreadError}
        renameThreadError={navigation.renameThreadError}
        runtimeIdentity={runtimeIdentity}
        activeProfile={profiles.activeProfile}
        profiles={profiles.profiles}
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
        onOpenSettings={() => {
          setSettingsInitialSection(undefined);
          setMainView("settings");
        }}
        onOpenProfile={profiles.openProfile}
        onSelectThread={(thread) => {
          setMainView("thread");
          navigation.selectThread(thread);
        }}
        onArchiveThread={navigation.archiveThread}
        onRenameThread={navigation.renameThread}
        onSetThreadReaction={navigation.setThreadReaction}
        onSetThreadPin={navigation.setThreadPin}
        onReorderThreadPins={navigation.reorderThreadPins}
        onPrefetchPullRequests={pullRequests.prefetch}
        onUnbindMessagingBinding={async (_thread, binding) => {
          if (!desktopApi?.unbindMessagingThread) return;
          await desktopApi.unbindMessagingThread({ bindingId: binding.bindingId });
          await navigation.refresh?.();
        }}
        onResizeStart={startSidebarResize}
        onResizeByKeyboard={(delta) => resizeSidebar(sidebarWidth + delta)}
      />

      <main className="app-main">
        {ThreadViewComponent ? <ThreadViewComponent {...threadViewProps} /> : null}
      </main>

      {mainView === "settings" ? (
        <div className="app-shell__settings-layer">
          <SettingsScreen
            desktopApi={desktopApi}
            initialSection={settingsInitialSection}
            profiles={profiles}
            settings={settings}
            onClose={() => setMainView("thread")}
            onOpenMessagingActivity={openMessagingActivityWindow}
          />
        </div>
      ) : null}

      <AppUpdateBanner desktopApi={desktopApi} />
    </div>
  );
}
