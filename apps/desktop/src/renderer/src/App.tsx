import {
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type CSSProperties,
  type PointerEvent,
} from "react";
import type {
  DesktopBootInfo,
  DesktopCodexProfileModel,
  DesktopPwrAgentProfileSummary,
} from "@pwragent/shared";
import { Sidebar } from "./features/navigation/Sidebar";
import { OnboardingWizard } from "./features/onboarding/OnboardingWizard";
import {
  SettingsScreen,
  type SettingsSection,
} from "./features/settings/SettingsScreen";
import {
  useDesktopSettings,
  type DesktopSettingsState,
} from "./features/settings/useDesktopSettings";
import type { ThreadViewProps } from "./features/thread-detail/ThreadView";
import { ThreadPlaceholderHeader } from "./features/thread-detail/ThreadPlaceholderHeader";
import { useComposerDraftStore } from "./features/composer/useComposerDraftStore";
import { useDurableComposerDraftStore } from "./features/composer/useDurableComposerDraftStore";
import { useAppearance, type AppearanceController } from "./lib/useAppearance";
import { useBackendSummaries } from "./lib/useBackendSummaries";
import { useDesktopApi, type DesktopApi } from "./lib/desktop-api";
import { useRuntimeIdentity } from "./lib/runtime-identity";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { usePwrAgentProfiles } from "./lib/usePwrAgentProfiles";
import { usePullRequestRefresh } from "./features/pr-status/usePullRequestRefresh";
import { useThreadSessionState } from "./lib/useThreadSessionState";
import { useThreadSkills } from "./lib/useThreadSkills";
import { useQueuedTurnRelease } from "./lib/useQueuedTurnRelease";
import { CodexConfigWarningBanner } from "./features/codex-config/CodexConfigWarningBanner";
import { AppUpdateBanner } from "./features/update/AppUpdateBanner";
import { AutomationsScreen } from "./features/automations/AutomationsScreen";

const SETTINGS_SECTIONS = new Set<SettingsSection>([
  "general",
  "applications",
  "profiles",
  "worktrees",
  "messaging",
  "models",
  "experimental",
  "about",
]);

export function App() {
  const desktopApi = useDesktopApi();
  const settings = useDesktopSettings(desktopApi);
  // Owns live theme + density state. Source of truth is per-profile
  // config.toml; the snapshot pulls it in over IPC, the hook adopts it
  // when available, and setters write back via writeSettingsConfig.
  // The pre-React bootstrap script in index.html already set the initial
  // data-* attributes from the preload-bridged value (same TOML, sync
  // read at window-creation), so first-paint matches and this hook just
  // keeps the React state aligned + handles system-theme flips. Lifted
  // to the App root so a single controller instance is shared across the
  // shell and the Settings → General → Appearance section.
  const appearanceController = useAppearance({
    snapshotPreference: settings.snapshot?.general.appearance
      ? {
        theme: settings.snapshot.general.appearance.theme.value,
        density: settings.snapshot.general.appearance.density.value,
      }
      : undefined,
    writeConfig: settings.writeConfig,
  });

  if (desktopApi?.readSettings && !settings.snapshot && settings.error) {
    return (
      <div className="app-shell app-shell--fatal-settings">
        <main className="app-main">
          <SettingsScreen
            appearanceController={appearanceController}
            desktopApi={desktopApi}
            settings={settings}
          />
        </main>
      </div>
    );
  }

  if (settings.snapshot?.configError) {
    return (
      <div className="app-shell app-shell--fatal-settings">
        <main className="app-main">
          <SettingsScreen
            appearanceController={appearanceController}
            desktopApi={desktopApi}
            settings={settings}
          />
        </main>
      </div>
    );
  }

  return (
    <DesktopAppShell
      appearanceController={appearanceController}
      desktopApi={desktopApi}
      settings={settings}
    />
  );
}

function DesktopAppShell(props: {
  appearanceController: AppearanceController;
  desktopApi?: DesktopApi;
  settings: DesktopSettingsState;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(408);
  // Hardcoded sidebar resize bounds — mirrored in resizeSidebar() below.
  // Exposed as constants so both the setter and the aria-valuemin/max
  // attributes on the resize handle stay in sync.
  const sidebarMinWidth = 280;
  const sidebarMaxWidth = 560;
  const [mainView, setMainView] = useState<"thread" | "settings" | "automations">(
    "thread",
  );
  // Initial section for SettingsScreen — non-undefined when navigation
  // came from a deep-link to a specific section. Resets when the user
  // switches mainView. The Messaging Activity surface is its own
  // dedicated BrowserWindow, NOT a settings section, so it never
  // appears through this slot.
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    SettingsSection | undefined
  >(undefined);
  const [threadViewReady, setThreadViewReady] = useState(false);
  // Onboarding wizard overlay state. Two paths into it:
  //  (1) auto-launch on first snapshot if `onboarding.completed` is
  //      false for the active profile;
  //  (2) explicit replay via Help → Replay Onboarding (main process
  //      menu push → renderer subscribes below).
  // The auto-launch leans on `autoOpenSeen` so we don't re-open after
  // the user dismisses without persisting (snapshot refresh case).
  const [onboardingOpen, setOnboardingOpen] = useState<
    "auto" | "replay" | null
  >(null);
  const [autoOpenSeen, setAutoOpenSeen] = useState(false);
  // Boot info is fetched once on mount and is stable across the
  // renderer's lifetime (the main process recorded it before this
  // window opened — see `recordBootDecision` in app-state.ts). The
  // wizard uses this to pick its entry mode: `missing-named-profile`
  // triggers the slim "set up `foo`?" confirmation step; everything
  // else uses the standard first-run / replay flow.
  const [bootInfo, setBootInfo] = useState<DesktopBootInfo | null>(null);
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
  const revealSelectedThreadInList = useCallback(() => {
    const selectedRow = document.querySelector<HTMLElement>(
      ".sidebar .thread-row.is-selected",
    );
    selectedRow?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, []);
  const settings = props.settings;
  const normalAppEnabled =
    !desktopApi?.readSettings ||
    (Boolean(settings.snapshot) &&
      settings.snapshot?.onboarding?.completed.value !== false);
  const profiles = usePwrAgentProfiles(desktopApi);
  const runtimeIdentity = useRuntimeIdentity(desktopApi);
  const navigation = useThreadNavigation(desktopApi, {
    enabled: normalAppEnabled,
    threadViewVisible: mainView === "thread",
  });
  const backendSummaries = useBackendSummaries(desktopApi, {
    enabled: normalAppEnabled,
  });
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
  const replayCodexProfileSetup = settings.snapshot
    ? inferReplayCodexProfileSetup(
        settings.snapshot.general.codexProfileModel?.value ?? "shared",
        profiles.profiles,
      )
    : undefined;
  useQueuedTurnRelease({
    backends: backendSummaries.backends,
    composerDraftStore,
    desktopApi,
    selectedThread: navigation.selectedThread,
    threads: navigation.threads,
  });
  // Fetch the boot info once at mount. Stable for the renderer's
  // lifetime — the main process records the decision before this
  // window opens, and graduating the bootstrap profile spawns a
  // fresh main window with its own boot decision.
  useEffect(() => {
    if (!desktopApi?.getBootInfo) return;
    let cancelled = false;
    void desktopApi.getBootInfo().then((info) => {
      if (!cancelled) setBootInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);
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
  useEffect(() => {
    // Subscribe to the PwrAgent → Settings… menu push. The Settings
    // overlay is in-renderer (not a separate BrowserWindow), so the
    // main process sends a fire-and-forget message instead of opening
    // a window directly. Mirrors what the sidebar's gear-icon button
    // does inline.
    if (!desktopApi?.onOpenSettingsRequested) {
      return;
    }
    return desktopApi.onOpenSettingsRequested((section) => {
      setSettingsInitialSection(
        isSettingsSection(section) ? section : undefined,
      );
      setMainView("settings");
    });
  }, [desktopApi]);
  useEffect(() => {
    // Subscribe to Help → Replay Onboarding push from the menu. Forces
    // the wizard overlay open in "replay" mode — dismissal does NOT
    // touch `onboarding.completed`.
    if (!desktopApi?.onReplayOnboardingRequested) {
      return;
    }
    return desktopApi.onReplayOnboardingRequested(() => {
      void profiles.refresh().finally(() => {
        setOnboardingOpen("replay");
      });
    });
  }, [desktopApi, profiles.refresh]);
  useEffect(() => {
    // Auto-launch on the first snapshot where `completed === false`.
    // `autoOpenSeen` blocks re-opens after the user dismissed without
    // persisting (which can happen if they hit ESC). Once shown, the
    // wizard's Skip/Finish path writes `completed = true` and the
    // snapshot path stops triggering us on subsequent refreshes.
    const completed = settings.snapshot?.onboarding?.completed.value;
    if (
      completed === false &&
      onboardingOpen === null &&
      !autoOpenSeen
    ) {
      setOnboardingOpen("auto");
      setAutoOpenSeen(true);
    }
  }, [
    autoOpenSeen,
    onboardingOpen,
    settings.snapshot?.onboarding?.completed.value,
  ]);
  const loadThreadDetail = threadViewReady && mainView === "thread";
  const session = useThreadSessionState({
    desktopApi,
    liveTranscriptEventFiltering:
      settings.snapshot?.experimental.liveTranscriptEventFiltering?.value ?? false,
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
    onRevealSelectedThreadInList: revealSelectedThreadInList,
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
    onSetAcpRuntimeOption: navigation.selectedThread
      ? async (params) =>
          await navigation.setAcpSessionRuntimeOption(
            navigation.selectedThread!,
            params,
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
  const selectedThreadPending =
    Boolean(navigation.selectedThreadKey) &&
    !navigation.selectedThread &&
    !navigation.selectedLaunchpad &&
    (navigation.loading || navigation.refreshing);
  const threadDetailPending =
    mainView === "thread" && (!ThreadViewComponent || selectedThreadPending);

  const resizeSidebar = (nextWidth: number): void => {
    setSidebarWidth(Math.min(sidebarMaxWidth, Math.max(sidebarMinWidth, nextWidth)));
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
        automationsActive={mainView === "automations"}
        settingsActive={mainView === "settings"}
        onBrowseModeChange={navigation.setBrowseMode}
        onCreateThread={navigation.createThread}
        onOpenAutomations={() => {
          setMainView("automations");
        }}
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
        onSetDirectoryPin={navigation.setDirectoryPin}
        onReorderDirectoryPins={navigation.reorderDirectoryPins}
        onPrefetchPullRequests={pullRequests.prefetch}
        onUnbindMessagingBinding={async (_thread, binding) => {
          if (!desktopApi?.unbindMessagingThread) return;
          await desktopApi.unbindMessagingThread({ bindingId: binding.bindingId });
          await navigation.refresh?.();
        }}
        onResizeStart={startSidebarResize}
        onResizeByKeyboard={(delta) => resizeSidebar(sidebarWidth + delta)}
        sidebarWidth={sidebarWidth}
        sidebarMinWidth={sidebarMinWidth}
        sidebarMaxWidth={sidebarMaxWidth}
      />

      <main
        className={`app-main${
          threadDetailPending ? " app-main--thread-detail-pending" : ""
        }`}
      >
        {threadDetailPending ? (
          <section className="thread-view thread-view--pending">
            <ThreadPlaceholderHeader
              desktopApi={desktopApi}
              title="Loading..."
              onOpenMessagingActivity={openMessagingActivityWindow}
            />
          </section>
        ) : ThreadViewComponent ? (
          <ThreadViewComponent {...threadViewProps} />
        ) : null}
      </main>

      {mainView === "settings" ? (
        <div className="app-shell__settings-layer">
          <SettingsScreen
            appearanceController={props.appearanceController}
            desktopApi={desktopApi}
            initialSection={settingsInitialSection}
            profiles={profiles}
            settings={settings}
            onClose={() => setMainView("thread")}
            onOpenMessagingActivity={openMessagingActivityWindow}
          />
        </div>
      ) : null}

      {mainView === "automations" ? (
        <div className="app-shell__settings-layer">
          <AutomationsScreen
            desktopApi={desktopApi}
            threads={navigation.threads}
            onClose={() => setMainView("thread")}
            onOpenMessagingActivity={openMessagingActivityWindow}
            onRefreshNavigation={navigation.refresh}
            onSelectThread={(thread) => {
              setMainView("thread");
              navigation.selectThread(thread);
            }}
          />
        </div>
      ) : null}

      {onboardingOpen !== null && settings.snapshot ? (
        <OnboardingWizard
          isReplay={onboardingOpen === "replay"}
          bootInfo={bootInfo}
          initialDensity={settings.snapshot.general.appearance.density.value}
          initialTheme={settings.snapshot.general.appearance.theme.value}
          initialCodexProfileModel={
            onboardingOpen === "replay" && replayCodexProfileSetup
              ? replayCodexProfileSetup.model
              : settings.snapshot.general.codexProfileModel.value
          }
          initialCodexProfileNames={
            onboardingOpen === "replay"
              ? replayCodexProfileSetup?.profileNames
              : undefined
          }
          appearanceController={props.appearanceController}
          settings={settings}
          desktopApi={desktopApi}
          onComplete={async (patch) => {
            await settings.writeConfig(patch);
            // The wizard already flips theme + density live via
            // appearanceController as the operator clicks — the
            // explicit setters below are a belt-and-suspenders to keep
            // the controller's React state aligned with whatever the
            // final patch holds, even if persistAndComplete adjusts.
            if (patch.general?.appearance?.density) {
              props.appearanceController.setDensity(
                patch.general.appearance.density,
              );
            }
            if (patch.general?.appearance?.theme) {
              props.appearanceController.setTheme(
                patch.general.appearance.theme,
              );
            }
            // Mark onboarding complete AND kick off the deferred Codex
            // `listThreads` prefetch in one IPC call (#500). On replay,
            // skip the call entirely — replays don't touch onboarding.
            //
            // In bootstrap mode (#524), skip this too. The bootstrap
            // window is about to quit; firing
            // `completeOnboardingCodexBootstrap` here would (a) write
            // `[onboarding] completed = true` to `.bootstrap/config.toml`
            // (which we're about to delete) and (b) trigger a Codex
            // `listThreads` against the system default Codex install,
            // contaminating the soon-to-quit window with the operator's
            // real Codex Desktop threads. The new profile's window
            // handles its own completion + prefetch on launch.
            if (!onboardingOpen) return;
            if (
              onboardingOpen !== "replay" &&
              bootInfo?.mode !== "bootstrap" &&
              desktopApi?.completeOnboardingCodexBootstrap
            ) {
              await desktopApi.completeOnboardingCodexBootstrap({
                connect: true,
              });
              await settings.refresh();
            }
            setOnboardingOpen(null);
          }}
          onDismiss={(persistCompleted) => {
            if (persistCompleted) {
              // Skip path: persist `completed = true` so the wizard
              // doesn't auto-fire again, but pass `connect: false` so
              // we don't auto-load Codex threads under an unverified
              // identity. The renderer's next explicit refresh (or app
              // restart) will surface them.
              void desktopApi?.completeOnboardingCodexBootstrap?.({
                connect: false,
              }).then(() => settings.refresh());
            }
            setOnboardingOpen(null);
          }}
          onOpenMessagingSettings={() => {
            setSettingsInitialSection("messaging");
            setMainView("settings");
          }}
        />
      ) : null}

      <CodexConfigWarningBanner desktopApi={desktopApi} />
      <AppUpdateBanner desktopApi={desktopApi} />
    </div>
  );
}

function isSettingsSection(
  section: string | undefined,
): section is SettingsSection {
  return (
    section !== undefined && SETTINGS_SECTIONS.has(section as SettingsSection)
  );
}

export type ReplayCodexProfileSetup = {
  model: DesktopCodexProfileModel;
  profileNames?: readonly string[];
};

export function inferReplayCodexProfileSetup(
  persisted: DesktopCodexProfileModel,
  profiles: readonly DesktopPwrAgentProfileSummary[],
): ReplayCodexProfileSetup {
  const namedPairings = profiles.filter((profile) => profile.codexProfile.name);
  if (namedPairings.length >= 2) {
    return {
      model: "multiple",
      profileNames: namedPairings.map((profile) => profile.name),
    };
  }

  const activeProfile = profiles.find((profile) => profile.active);
  const isolatedProfile = activeProfile?.codexProfile.name
    ? activeProfile
    : namedPairings[0];
  if (isolatedProfile) {
    return { model: "isolated", profileNames: [isolatedProfile.name] };
  }

  return { model: persisted };
}

export function inferReplayCodexProfileModel(
  persisted: DesktopCodexProfileModel,
  profiles: readonly DesktopPwrAgentProfileSummary[],
): DesktopCodexProfileModel {
  return inferReplayCodexProfileSetup(persisted, profiles).model;
}
