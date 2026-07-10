import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  buildThreadIdentityKey,
  parseThreadIdentityKey,
  type DesktopBootInfo,
  type DesktopCodexProfileModel,
  type DesktopPwrAgentProfileSummary,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { Sidebar } from "./features/navigation/Sidebar";
import { AppTitleBar } from "./features/chrome/AppTitleBar";
import type { HistoryNavControls } from "./features/chrome/HistoryNavButtons";
import { useFindHotkeys } from "./features/chrome/useFindHotkeys";
import { useHistoryNavHotkeys } from "./features/chrome/useHistoryNavHotkeys";
import { useLayoutChordHotkeys } from "./features/chrome/useLayoutChordHotkeys";
import type { SettingsSection } from "./features/settings/SettingsScreen";
import {
  useDesktopSettings,
  type DesktopSettingsState,
} from "./features/settings/useDesktopSettings";
import type { ThreadViewProps } from "./features/thread-detail/ThreadView";
import {
  DEFAULT_CONTEXT_TAB,
  DEFAULT_ACTION_RUNS_DOCK,
  DEFAULT_EDITED_FILES_DOCK,
  isActionRunsDock,
  isContextTabId,
  isEditedFilesDock,
  type ActionRunsDock,
  type ContextTabId,
  type EditedFilesDock,
} from "./features/thread-detail/context-panels/context-tab";
import { ThreadPlaceholderHeader } from "./features/thread-detail/ThreadPlaceholderHeader";
import { useComposerDraftStore } from "./features/composer/useComposerDraftStore";
import { useDurableComposerDraftStore } from "./features/composer/useDurableComposerDraftStore";
import { useAppearance, type AppearanceController } from "./lib/useAppearance";
import { useBackendSummaries } from "./lib/useBackendSummaries";
import { useDesktopApi, type DesktopApi } from "./lib/desktop-api";
import { useRuntimeIdentity } from "./lib/runtime-identity";
import {
  useNavigationHistory,
  type NavigationHistoryLocation,
} from "./lib/useNavigationHistory";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { usePwrAgentProfiles } from "./lib/usePwrAgentProfiles";
import { usePullRequestRefresh } from "./features/pr-status/usePullRequestRefresh";
import {
  LIGHTWEIGHT_INITIAL_THREAD_HISTORY_LIMIT,
  useThreadSessionState,
} from "./lib/useThreadSessionState";
import { setSidebarResizing } from "./lib/sidebar-resize-signal";
import { useThreadSkills } from "./lib/useThreadSkills";
import { useQueuedTurnRelease } from "./lib/useQueuedTurnRelease";
import { CodexConfigWarningBanner } from "./features/codex-config/CodexConfigWarningBanner";
import { AppNoticeToast } from "./features/notifications/AppNoticeToast";
import type { AppNoticeToastNotice } from "./features/notifications/AppNoticeToast";
import { resolveBackendErrorNotice } from "./features/notifications/backend-error-notice";
import {
  buildHotCpuProfileHandoffMessage,
  formatHotCpuProfileTriggerSummary,
} from "../../shared/hot-cpu-profile";
import { AppUpdateBanner } from "./features/update/AppUpdateBanner";
import { AutomationsScreen } from "./features/automations/AutomationsScreen";
import {
  ThreadSearchPanel,
  useThreadSearchPanelState,
} from "./features/thread-search/ThreadSearchPanel";

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

const LazySettingsScreen = lazy(async () => ({
  default: (await import("./features/settings/SettingsScreen")).SettingsScreen,
}));

const LazyOnboardingWizard = lazy(async () => ({
  default: (await import("./features/onboarding/OnboardingWizard")).OnboardingWizard,
}));

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
      <>
        <AppTitleBar />
        <div className="app-shell app-shell--fatal-settings">
          <main className="app-main">
            <Suspense fallback={null}>
              <LazySettingsScreen
                appearanceController={appearanceController}
                desktopApi={desktopApi}
                settings={settings}
              />
            </Suspense>
          </main>
        </div>
      </>
    );
  }

  if (settings.snapshot?.configError) {
    return (
      <>
        <AppTitleBar />
        <div className="app-shell app-shell--fatal-settings">
          <main className="app-main">
            <Suspense fallback={null}>
              <LazySettingsScreen
                appearanceController={appearanceController}
                desktopApi={desktopApi}
                settings={settings}
              />
            </Suspense>
          </main>
        </div>
      </>
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
  // Live mirror of `sidebarWidth`. A pointer drag updates this ref (and the
  // DOM) on every move WITHOUT calling setState, so the `.app-shell` rerender
  // (→ Sidebar → every un-virtualized ThreadRow) that used to fire on each
  // pointermove is gone. The `.app-shell` CSS var is rendered from the ref so
  // an incidental rerender mid-drag (e.g. an agent event) re-applies the live
  // dragged width instead of snapping back to the stale committed state.
  //
  // INVARIANT: the rendered width reads from this ref, so it must track state.
  // Write the width through `commitSidebarWidth` (below); never call
  // `setSidebarWidth` directly, or the rendered width diverges from state.
  const sidebarWidthRef = useRef(sidebarWidth);
  const appShellRef = useRef<HTMLDivElement>(null);
  // Hardcoded sidebar resize bounds — mirrored in clampSidebarWidth() below.
  // Exposed as constants so both the clamp and the aria-valuemin/max
  // attributes on the resize handle stay in sync.
  const sidebarMinWidth = 280;
  const sidebarMaxWidth = 560;
  // Window-level layout preferences (persisted to config — see the
  // `ui` settings section). The left sidebar can be hidden entirely and
  // the right context rail pinned open; the active rail tab is also
  // remembered. Seeded from the settings snapshot once it arrives.
  // The rail defaults to pinned-open (matches the persisted default) so a
  // fresh user discovers it without a collapse→expand flash on first paint.
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [contextRailPinned, setContextRailPinned] = useState(true);
  const [activeContextTab, setActiveContextTab] =
    useState<ContextTabId>(DEFAULT_CONTEXT_TAB);
  const [editedFilesDock, setEditedFilesDock] = useState<EditedFilesDock>(
    DEFAULT_EDITED_FILES_DOCK,
  );
  const [actionRunsDock, setActionRunsDock] = useState<ActionRunsDock>(
    DEFAULT_ACTION_RUNS_DOCK,
  );
  const [mainView, setMainView] = useState<
    "thread" | "settings" | "automations" | "search"
  >("thread");
  // In-thread find bar (⌘F). `manualFindOpen` is the ⌘F toggle; `findRequest`
  // is a deep-link from a search result (seeded query + its target thread).
  // The bar is open when either applies (see `threadFindOpen` below).
  const [manualFindOpen, setManualFindOpen] = useState(false);
  const [findRequest, setFindRequest] = useState<{
    query: string;
    threadKey: string;
    turnId?: string;
  }>();
  // Thread-list quick-jump popup (⌘F while the sidebar is focused).
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
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
  // Transient composer-originated notices (image attachment limit reached,
  // pasted image rejected on a non-vision model). Rendered through the shared
  // AppNoticeToast in the toast stack below, separate from the navigation
  // archive notice so the two never clobber each other.
  const [composerNotice, setComposerNotice] = useState<AppNoticeToastNotice>();
  const [hotCpuProfileNotice, setHotCpuProfileNotice] =
    useState<AppNoticeToastNotice>();
  // Sticky (manual-dismiss) notice for backend turn failures and system
  // errors. These used to vanish silently — the turn just stopped thinking
  // with nothing to show for it. The toast stays until dismissed so a
  // mid-outage failure can't slip past unnoticed.
  const [backendErrorNotice, setBackendErrorNotice] =
    useState<AppNoticeToastNotice>();
  // One-shot warning surfaced when the main process skipped automations it
  // couldn't load (corrupt data, or a schedule/trigger shape written by a
  // newer build). The skipped automations are left untouched in storage — this
  // is the only signal the user gets that they were quietly not run, so it
  // stays until dismissed.
  const [automationLoadNotice, setAutomationLoadNotice] =
    useState<AppNoticeToastNotice>();
  // Latest thread list, mirrored into a ref so the backend-error toast
  // subscription can resolve a thread's title without re-subscribing on
  // every navigation change. Kept fresh by an effect below, once
  // `navigation` is defined.
  const backendErrorThreadsRef = useRef<NavigationThreadSummary[]>([]);
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

  useEffect(() => {
    return desktopApi?.onHotCpuProfileCaptured?.((event) => {
      const heapSnapshotCount = event.heapSnapshotArtifacts?.length ?? 0;
      const heapSnapshotSummary =
        heapSnapshotCount > 0
          ? ` ${heapSnapshotCount} heap snapshots captured.`
          : "";
      setHotCpuProfileNotice({
        autoDismiss: false,
        copyText: buildHotCpuProfileHandoffMessage(event),
        detail: `Session: ${event.sessionDirectoryName}`,
        id: `hot-cpu-profile:${event.capturedAt}:${event.profileFilename}`,
        title: "CPU profile captured",
        message: [
          `${formatHotCpuProfileTriggerSummary(event)} saved ${event.profileFilename}.`,
          heapSnapshotSummary,
          " Copy this notice to hand off the profile path.",
        ].join(""),
      });
    });
  }, [desktopApi]);

  // On startup, ask the main process whether it skipped any automations it
  // couldn't load. Startup reconciliation runs before this window exists, so a
  // pushed event would be missed — we pull the result once the renderer is up.
  useEffect(() => {
    if (!desktopApi?.listAutomationLoadIssues) {
      return;
    }
    let cancelled = false;
    void desktopApi
      .listAutomationLoadIssues()
      .then((response) => {
        if (cancelled || response.issues.length === 0) {
          return;
        }
        const issues = response.issues;
        const names = issues.map((issue) => issue.name).filter(Boolean);
        const namesSummary =
          names.length > 0 ? names.slice(0, 5).join(", ") : undefined;
        setAutomationLoadNotice({
          autoDismiss: false,
          id: `automation-load-issues:${issues.map((issue) => issue.id).join(",")}`,
          title:
            issues.length === 1
              ? "1 automation was skipped"
              : `${issues.length} automations were skipped`,
          message:
            "PwrAgent couldn't load some automations, so they did not run this session. They were left unchanged — open them in the newer version of PwrAgent that created them.",
          detail: namesSummary,
        });
      })
      .catch(() => {
        // Best-effort warning; never let it interfere with startup.
      });
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  // Surface backend turn failures + system errors as a durable toast. The
  // matching transcript entry (rendered from the thread overlay's
  // turnFailureLog) is the in-context record; this toast is the global
  // "something just broke" signal that has to be acknowledged. Notices are
  // keyed by thread so a failure on one thread can't suppress a signal from
  // another (see resolveBackendErrorNotice).
  useEffect(() => {
    const labelForThread = (backend: string, threadId?: string): string => {
      const match = threadId
        ? backendErrorThreadsRef.current.find(
            (thread) => thread.source === backend && thread.id === threadId,
          )
        : undefined;
      const title = match?.title?.trim();
      if (title) {
        return title;
      }
      return backend === "codex"
        ? "Codex thread"
        : backend === "grok"
          ? "Grok thread"
          : `${backend} thread`;
    };
    return desktopApi?.onAgentEvent?.((event) => {
      // Params are cast explicitly: the AppServerNotification union is too
      // wide for the discriminant to narrow `params` reliably here.
      if (event.notification.method === "turn/failed") {
        const params = event.notification.params as {
          threadId?: string;
          turnId?: string;
          turn?: { error?: { message?: unknown } };
        };
        const rawMessage = params.turn?.error?.message;
        const errorMessage =
          typeof rawMessage === "string" && rawMessage.trim()
            ? rawMessage
            : "The agent turn failed.";
        setBackendErrorNotice((current) =>
          resolveBackendErrorNotice(
            {
              kind: "turn-failed",
              backend: event.backend,
              threadId: params.threadId ?? "unknown",
              turnId: params.turnId ?? "unknown",
              errorMessage,
              threadLabel: labelForThread(event.backend, params.threadId),
            },
            current,
          ),
        );
        return;
      }
      if (event.notification.method === "thread/status/changed") {
        const params = event.notification.params as {
          threadId?: string;
          status?: { type?: string };
        };
        if (params.status?.type !== "systemError") {
          return;
        }
        setBackendErrorNotice((current) =>
          resolveBackendErrorNotice(
            {
              kind: "system-error",
              backend: event.backend,
              threadId: params.threadId ?? "unknown",
              threadLabel: labelForThread(event.backend, params.threadId),
            },
            current,
          ),
        );
        return;
      }
    });
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

  // Persisted layout setters — update local state immediately and write the
  // new value to config.toml's [ui] section so it survives a relaunch. The
  // writeConfig call is fire-and-forget; a failed write just means the
  // preference isn't remembered next launch.
  const writeConfig = settings.writeConfig;
  const setSidebarHiddenPersisted = useCallback(
    (next: boolean) => {
      setSidebarHidden(next);
      void writeConfig({ ui: { sidebarHidden: next } });
    },
    [writeConfig],
  );
  const setContextRailPinnedPersisted = useCallback(
    (next: boolean) => {
      setContextRailPinned(next);
      void writeConfig({ ui: { contextRailPinned: next } });
    },
    [writeConfig],
  );

  // Single owner of the window-layout keyboard chords (⌘B/⌃B sidebar,
  // ⌘⌥B/⌃⌥B rail). Bound once here — never per PanelToggleButtons chip — so
  // it fires exactly once regardless of how many chips are mounted.
  useLayoutChordHotkeys({
    onToggleSidebar: () => setSidebarHiddenPersisted(!sidebarHidden),
    onToggleRail: () => setContextRailPinnedPersisted(!contextRailPinned),
  });
  const setActiveContextTabPersisted = useCallback(
    (tab: ContextTabId) => {
      setActiveContextTab(tab);
      void writeConfig({ ui: { activeContextTab: tab } });
    },
    [writeConfig],
  );
  const setEditedFilesDockPersisted = useCallback(
    (dock: EditedFilesDock) => {
      setEditedFilesDock(dock);
      void writeConfig({ ui: { editedFilesDock: dock } });
    },
    [writeConfig],
  );
  const setActionRunsDockPersisted = useCallback(
    (dock: ActionRunsDock) => {
      setActionRunsDock(dock);
      void writeConfig({ ui: { actionRunsDock: dock } });
    },
    [writeConfig],
  );

  // Adopt the persisted layout prefs once the settings snapshot arrives.
  // Guarded so later snapshot refreshes never clobber an in-session toggle.
  const uiPrefsSeededRef = useRef(false);
  const uiPrefs = settings.snapshot?.ui;
  useEffect(() => {
    if (!uiPrefs || uiPrefsSeededRef.current) {
      return;
    }
    uiPrefsSeededRef.current = true;
    setSidebarHidden(uiPrefs.sidebarHidden.value);
    setContextRailPinned(uiPrefs.contextRailPinned.value);
    if (isContextTabId(uiPrefs.activeContextTab.value)) {
      setActiveContextTab(uiPrefs.activeContextTab.value);
    }
    const editedFilesDockPref = uiPrefs.editedFilesDock?.value;
    if (isEditedFilesDock(editedFilesDockPref)) {
      setEditedFilesDock(editedFilesDockPref);
    }
    const actionRunsDockPref = uiPrefs.actionRunsDock?.value;
    if (isActionRunsDock(actionRunsDockPref)) {
      setActionRunsDock(actionRunsDockPref);
    }
  }, [uiPrefs]);

  const normalAppEnabled =
    !desktopApi?.readSettings ||
    (Boolean(settings.snapshot) &&
      settings.snapshot?.onboarding?.completed.value !== false);
  const profiles = usePwrAgentProfiles(desktopApi);
  const runtimeIdentity = useRuntimeIdentity(desktopApi);
  const navigation = useThreadNavigation(desktopApi, {
    enabled: normalAppEnabled,
    lightweightNavigationRefresh:
      settings.snapshot?.experimental.lightweightNavigationRefresh?.value ?? false,
    threadViewVisible: mainView === "thread",
  });
  // Keep the backend-error toast's thread lookup fresh without making the
  // toast subscription depend on (and re-subscribe to) the thread list.
  useEffect(() => {
    backendErrorThreadsRef.current = navigation.threads;
  }, [navigation.threads]);
  const backendSummaries = useBackendSummaries(desktopApi, {
    enabled: normalAppEnabled,
  });
  const pullRequests = usePullRequestRefresh({
    desktopApi,
    onRefreshNavigation: navigation.refresh,
    selectedThread: navigation.selectedThread,
  });
  // Browser-style back/forward across threads and the search view. The
  // tracked location is (mainView, selected thread); Settings, Automations,
  // and launchpads stay untracked — they're modal-ish chrome, not places
  // you navigate back to (see useNavigationHistory). Search query/results
  // live up here so Back lands on a still-populated results list after
  // opening a result unmounts the panel.
  const threadSearchState = useThreadSearchPanelState();
  const historyLocation = useMemo<NavigationHistoryLocation | undefined>(() => {
    if (mainView === "search") {
      return { view: "search" };
    }
    if (mainView === "thread" && navigation.selectedThreadKey) {
      return { view: "thread", threadKey: navigation.selectedThreadKey };
    }
    return undefined;
  }, [mainView, navigation.selectedThreadKey]);
  const showThread = navigation.showThread;
  const restoreHistoryLocation = useCallback(
    (location: NavigationHistoryLocation): void => {
      if (location.view === "search") {
        setMainView("search");
        return;
      }
      setMainView("thread");
      const parts = parseThreadIdentityKey(location.threadKey);
      if (parts) {
        void showThread(parts);
      }
    },
    [showThread],
  );
  // Undefined while the snapshot is empty/loading so a transient blank
  // thread list can't wipe the stacks; otherwise dead threads (archived,
  // backend disconnected) are pruned from history.
  const liveThreadKeys = useMemo<ReadonlySet<string> | undefined>(
    () =>
      navigation.threads.length > 0
        ? new Set(
            navigation.threads.map((thread) =>
              buildThreadIdentityKey(thread.source, thread.id),
            ),
          )
        : undefined,
    [navigation.threads],
  );
  const history = useNavigationHistory({
    current: historyLocation,
    liveThreadKeys,
    restore: restoreHistoryLocation,
  });
  useHistoryNavHotkeys({ onBack: history.goBack, onForward: history.goForward });
  // ⌘⇧F / ⌃⇧F opens the global thread search screen. ⌘F (in-thread find /
  // thread-list quick search) is wired onto this same owner further below.
  useFindHotkeys({
    onOpenSearch: () => setMainView(mainView === "search" ? "thread" : "search"),
    onFind: () => {
      // The thread-list quick search (below) claims ⌘F while the sidebar is
      // focused; anywhere else ⌘F finds within the open thread.
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".sidebar")) {
        setSidebarSearchOpen(true);
        return;
      }
      if (mainView === "thread") {
        setManualFindOpen(true);
      }
    },
  });
  // Manual find is per-thread chrome: drop it when the operator leaves the
  // thread view or switches threads. The deep-link find (findRequest) closes
  // on its own — it's keyed to its target thread (see `threadFindOpen`).
  useEffect(() => {
    if (mainView !== "thread") {
      setManualFindOpen(false);
      setFindRequest(undefined);
    }
  }, [mainView]);
  // Manual find doesn't follow a thread switch. A deep-link find DOES follow to
  // its target thread — but once the operator navigates away from that target,
  // clear the request so returning to the thread later doesn't silently
  // re-open find with the stale query.
  const deepLinkLandedRef = useRef(false);
  useEffect(() => {
    setManualFindOpen(false);
    if (!findRequest) {
      deepLinkLandedRef.current = false;
      return;
    }
    if (navigation.selectedThreadKey === findRequest.threadKey) {
      deepLinkLandedRef.current = true;
    } else if (deepLinkLandedRef.current) {
      setFindRequest(undefined);
    }
  }, [navigation.selectedThreadKey, findRequest]);
  // Find bar is open for a manual ⌘F, or for a search deep-link while its
  // target thread is the one on screen.
  const deepLinkFindActive =
    findRequest !== undefined &&
    findRequest.threadKey === navigation.selectedThreadKey;
  const threadFindOpen = manualFindOpen || deepLinkFindActive;
  const threadFindInitialQuery = deepLinkFindActive ? findRequest.query : undefined;
  const threadFindTurnId = deepLinkFindActive ? findRequest.turnId : undefined;
  const historyNav: HistoryNavControls = useMemo(
    () => ({
      canGoBack: history.canGoBack,
      canGoForward: history.canGoForward,
      onBack: history.goBack,
      onForward: history.goForward,
    }),
    [history],
  );
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
    if (
      threadViewReady ||
      mainView !== "thread" ||
      navigation.loading ||
      !navigation.loaded
    ) {
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
  }, [
    mainView,
    navigation.loaded,
    navigation.loading,
    threadViewReady,
  ]);
  useEffect(() => {
    if (!threadViewReady || ThreadViewComponent) {
      return;
    }

    let cancelled = false;
    desktopApi?.recordStartupProfileEvent?.("thread-view-import:start");
    void import("./features/thread-detail/ThreadView").then((module) => {
      desktopApi?.recordStartupProfileEvent?.("thread-view-import:end");
      if (!cancelled) {
        setThreadViewComponent(() => module.ThreadView);
      }
    }).catch((error) => {
      desktopApi?.recordStartupProfileEvent?.("thread-view-import:error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [ThreadViewComponent, desktopApi, threadViewReady]);
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
    if (!desktopApi?.onOpenNewThreadRequested) {
      return;
    }
    return desktopApi.onOpenNewThreadRequested(() => {
      setMainView("thread");
      void navigation.createThread();
    });
  }, [desktopApi, navigation]);
  useEffect(() => {
    if (!desktopApi?.onShowThreadRequested) {
      return;
    }
    return desktopApi.onShowThreadRequested((request) => {
      setMainView("thread");
      void navigation.showThread(request);
    });
  }, [desktopApi, navigation]);
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
  const lightweightNavigationRefresh =
    settings.snapshot?.experimental.lightweightNavigationRefresh?.value ?? false;
  const session = useThreadSessionState({
    desktopApi,
    initialHistoryLimit: lightweightNavigationRefresh
      ? LIGHTWEIGHT_INITIAL_THREAD_HISTORY_LIMIT
      : undefined,
    liveTranscriptEventFiltering:
      settings.snapshot?.experimental.liveTranscriptEventFiltering?.value ?? false,
    thread: loadThreadDetail ? navigation.selectedThread : undefined,
  });
  const skills = useThreadSkills({
    desktopApi,
    launchpad: navigation.selectedLaunchpad,
    thread: loadThreadDetail ? navigation.selectedThread : undefined,
  });
  // Window-level masthead actions (Automations / Settings / New Thread).
  // Shared by the sidebar masthead's home (AppTitleBar on Windows) and the
  // thread-header relocation when the sidebar is hidden on macOS/Linux.
  const mastheadActions = {
    automationsActive: mainView === "automations",
    settingsActive: mainView === "settings",
    threadSearchActive: mainView === "search",
    creatingThread: Boolean(navigation.creatingThread),
    newThreadDirectoryLabel: navigation.newThreadDirectoryLabel,
    onOpenAutomations: () => {
      setMainView("automations");
    },
    onOpenSettings: () => {
      setSettingsInitialSection(undefined);
      setMainView("settings");
    },
    onToggleThreadSearch: () => {
      setMainView(mainView === "search" ? "thread" : "search");
    },
    onCreateThread: async () => {
      setMainView("thread");
      await navigation.createThread();
    },
    onCreateThreadWithoutDirectory: async () => {
      setMainView("thread");
      await navigation.createThread(undefined, "default", { forceWorkspace: true });
    },
  };
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
    onShowNotice: setComposerNotice,
    loading: session.loading,
    loadingMore: session.loadingMore,
    messageCount: session.messages.length,
    contextWindow: session.contextWindow,
    pricing: session.response?.pricing,
    toolAccounting: session.response?.toolAccounting,
    threadPricingSummaryEnabled:
      settings.snapshot?.experimental.threadPricingSummary?.value ?? true,
    pricingDisplayOptions: {
      codexCredits:
        settings.snapshot?.experimental.threadPricingDisplayCodexCredits?.value ??
        false,
      usd: settings.snapshot?.experimental.threadPricingDisplayUsd?.value ?? true,
    },
    pendingAssistantMessage: session.pendingAssistantMessage,
    pendingMcpInteraction: session.pendingMcpInteraction,
    pendingRequest: session.pendingRequest,
    pendingUserInput: session.pendingUserInput,
    pendingStatusText: session.pendingStatusText,
    runningTurnUsageText: session.runningTurnUsageText,
    threadBusy: session.threadBusy,
    pastedImageMaxPatches:
      settings.snapshot?.imageUploads.pastedImageMaxPatches.value,
    platform: desktopApi?.platform,
    ...(navigation.creatingThread?.pendingForkEnvironmentSetup
      ? {
          pendingForkEnvironmentSetup:
            navigation.creatingThread.pendingForkEnvironmentSetup,
        }
      : {}),
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
    onSelectNoDirectoryFromPicker: () => {
      void navigation.openWorkspaceLaunchpad();
    },
    onPickAndRegisterDirectory: () => {
      void navigation.pickAndRegisterDirectory();
    },
    onPickAndAttachDirectoryToThread: () => {
      void navigation.pickAndAttachDirectoryToSelectedThread();
    },
    onClearPickDirectoryError: navigation.clearPickDirectoryError,
    setExecutionModeError: navigation.setThreadExecutionModeError,
    setThreadModelSettingsError: navigation.setThreadModelSettingsError,
    skillError: skills.error,
    skillLoading: skills.loading,
    providerCommands: skills.providerCommands,
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
    contextRailPinned,
    onContextRailPinnedChange: setContextRailPinnedPersisted,
    activeContextTab,
    onActiveContextTabChange: setActiveContextTabPersisted,
    editedFilesDock,
    onEditedFilesDockChange: setEditedFilesDockPersisted,
    actionRunsDock,
    onActionRunsDockChange: setActionRunsDockPersisted,
    sidebarHidden,
    onToggleSidebar: () => setSidebarHiddenPersisted(!sidebarHidden),
    mastheadActions,
    historyNav,
    findOpen: threadFindOpen,
    findInitialQuery: threadFindInitialQuery,
    findTurnId: threadFindTurnId,
    onFindOpenChange: (open: boolean) => {
      // The bar only ever calls this to close itself (Escape / ✕). Clear both
      // the manual toggle and any deep-link request so it stays closed.
      if (!open) {
        setManualFindOpen(false);
        setFindRequest(undefined);
      }
    },
    onHandoffThreadWorkspace: navigation.selectedThread
      ? async (request) =>
          await navigation.handoffThreadWorkspace(
            navigation.selectedThread!,
            request
          )
      : undefined,
    onLoadOlder: session.loadOlder,
    onLiveTranscriptEntry: session.upsertLiveTranscriptEntry,
    onCancelLaunchpad: navigation.discardLaunchpad,
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

  const clampSidebarWidth = (nextWidth: number): number =>
    Math.min(sidebarMaxWidth, Math.max(sidebarMinWidth, nextWidth));

  // The single writer of the sidebar width: keeps `sidebarWidthRef` (which the
  // rendered `--sidebar-width` reads from) and React state in lockstep. The
  // per-frame drag path writes the ref + DOM directly for speed and calls this
  // only once on pointerup; every other caller goes through here.
  const commitSidebarWidth = (width: number): void => {
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
  };

  // Keyboard / commit path: a discrete, low-frequency width change.
  const resizeSidebar = (nextWidth: number): void => {
    commitSidebarWidth(clampSidebarWidth(nextWidth));
  };

  const startSidebarResize = (event: PointerEvent<HTMLElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    let frame = 0;

    const flush = (): void => {
      frame = 0;
      appShellRef.current?.style.setProperty(
        "--sidebar-width",
        `${sidebarWidthRef.current}px`,
      );
    };
    const move = (moveEvent: globalThis.PointerEvent): void => {
      // Update the live width synchronously so any incidental rerender reads
      // the current value, but coalesce the actual DOM write to one per frame.
      sidebarWidthRef.current = clampSidebarWidth(
        startWidth + moveEvent.clientX - startX,
      );
      if (frame === 0) {
        frame = window.requestAnimationFrame(flush);
      }
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      // Make sure the DOM is at the final width before the transcript
      // re-syncs (the last move's rAF flush may have been cancelled above).
      flush();
      // Commit the final width to React state exactly once so it survives
      // future rerenders and drives `aria-valuenow` — a single reconcile in
      // place of one per pointermove.
      commitSidebarWidth(sidebarWidthRef.current);
      // Release the transcript's resize/scroll sync, which re-syncs once now
      // that the pane has settled at its final width.
      setSidebarResizing(false);
    };

    // Pause the transcript's per-frame ResizeObserver/onScroll re-sync for the
    // duration of the drag — the main pane reflows on every frame, and the
    // un-virtualized transcript responding to each reflow is the dominant cost
    // (see lib/sidebar-resize-signal.ts).
    setSidebarResizing(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <>
      <AppTitleBar
        desktopApi={desktopApi}
        onOpenMessagingActivity={openMessagingActivityWindow}
        layout={{
          sidebarOpen: !sidebarHidden,
          railOpen: contextRailPinned,
          onToggleSidebar: () => setSidebarHiddenPersisted(!sidebarHidden),
          onToggleRail: () => setContextRailPinnedPersisted(!contextRailPinned),
        }}
        actions={mastheadActions}
      />
      <div
        ref={appShellRef}
        className="app-shell"
        data-sidebar-hidden={sidebarHidden ? "true" : undefined}
        style={{ "--sidebar-width": `${sidebarWidthRef.current}px` } as CSSProperties}
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
          inputRequestThreadKeys={session.inputRequestThreadKeys}
          composerSourceThreadKey={navigation.composerSourceThreadKey}
          selectedItemKey={navigation.selectedItemKey}
          thinkingThreadKeys={session.thinkingThreadKeys}
          threads={navigation.threads}
          automationsActive={mainView === "automations"}
          threadSearchActive={mainView === "search"}
          settingsActive={mainView === "settings"}
          onBrowseModeChange={navigation.setBrowseMode}
          newThreadDirectoryLabel={navigation.newThreadDirectoryLabel}
          onCreateThread={async () => {
            setMainView("thread");
            await navigation.createThread();
          }}
          onCreateThreadWithoutDirectory={async () => {
            setMainView("thread");
            await navigation.createThread(undefined, "default", {
              forceWorkspace: true,
            });
          }}
          onCreateSubthread={async (thread, mode) => {
            setMainView("thread");
            await navigation.createSubthread(thread, mode);
          }}
          onForkThread={async (thread, mode) => {
            setMainView("thread");
            await navigation.forkThread(thread, mode);
          }}
          onOpenAutomations={() => {
            setMainView("automations");
          }}
          onOpenThreadSearch={() => {
            setMainView(mainView === "search" ? "thread" : "search");
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
          threadJumpOpen={sidebarSearchOpen}
          onThreadJumpOpenChange={setSidebarSearchOpen}
          onJumpToThread={(thread) => {
            setMainView("thread");
            navigation.selectThread(thread);
            requestAnimationFrame(() => revealSelectedThreadInList());
          }}
          onArchiveThread={navigation.archiveThread}
          onRenameThread={navigation.renameThread}
          onSetThreadReaction={navigation.setThreadReaction}
          onSetThreadPin={navigation.setThreadPin}
          onReorderThreadPins={navigation.reorderThreadPins}
          onSetThreadParent={navigation.setThreadParent}
          onUpdateSubthreadOrder={navigation.updateSubthreadOrder}
          onSetSubthreadsCollapsed={navigation.setSubthreadsCollapsed}
          onSetDirectoryPin={navigation.setDirectoryPin}
          onReorderDirectoryPins={navigation.reorderDirectoryPins}
          onPrefetchPullRequests={pullRequests.prefetch}
          onDetachPullRequest={async (thread, pr) => {
            if (!desktopApi?.detachThreadPullRequest) return;
            await desktopApi.detachThreadPullRequest({
              backend: thread.source,
              threadId: thread.id,
              pr,
            });
            await navigation.refresh?.();
          }}
          onUnbindMessagingBinding={async (_thread, binding) => {
            if (!desktopApi?.unbindMessagingThread) return;
            await desktopApi.unbindMessagingThread({ bindingId: binding.bindingId });
            await navigation.refresh?.();
          }}
          onResizeStart={startSidebarResize}
          onResizeByKeyboard={(delta) => resizeSidebar(sidebarWidthRef.current + delta)}
          sidebarWidth={sidebarWidth}
          sidebarMinWidth={sidebarMinWidth}
          sidebarMaxWidth={sidebarMaxWidth}
        />

        <main
          className={`app-main${
            threadDetailPending ? " app-main--thread-detail-pending" : ""
          }`}
        >
          {mainView === "search" ? (
            <ThreadSearchPanel
              desktopApi={desktopApi}
              onOpenMessagingActivity={openMessagingActivityWindow}
              layout={{
                sidebarOpen: !sidebarHidden,
                railOpen: contextRailPinned,
                onToggleSidebar: () => setSidebarHiddenPersisted(!sidebarHidden),
                onToggleRail: () => setContextRailPinnedPersisted(!contextRailPinned),
              }}
              masthead={mastheadActions}
              history={historyNav}
              state={threadSearchState}
              threads={navigation.threads}
              onClose={() => {
                // Esc pops the search screen off the history stack (same as the
                // title-bar Back button); if there's nowhere to go back to,
                // just leave the search view.
                if (history.canGoBack) {
                  history.goBack();
                } else {
                  setMainView("thread");
                }
              }}
              onOpenResult={async (result) => {
                // Deep-link to the match: open the thread with the find bar
                // seeded with the search query so it highlights + scrolls the
                // matched message into view (auto-loading older history if the
                // match lives further up than the first page).
                const seed = threadSearchState.query.trim();
                setFindRequest(
                  seed
                    ? {
                        query: seed,
                        threadKey: buildThreadIdentityKey(
                          result.backend,
                          result.threadId,
                        ),
                        turnId: result.turnId,
                      }
                    : undefined,
                );
                setMainView("thread");
                await navigation.showThread(result);
              }}
            />
          ) : threadDetailPending ? (
            <section className="thread-view thread-view--pending">
              <ThreadPlaceholderHeader
                desktopApi={desktopApi}
                title="Loading..."
                onOpenMessagingActivity={openMessagingActivityWindow}
                layout={{
                  sidebarOpen: !sidebarHidden,
                  railOpen: contextRailPinned,
                  onToggleSidebar: () => setSidebarHiddenPersisted(!sidebarHidden),
                  onToggleRail: () => setContextRailPinnedPersisted(!contextRailPinned),
                }}
                masthead={mastheadActions}
                history={historyNav}
              />
            </section>
          ) : ThreadViewComponent ? (
            <ThreadViewComponent {...threadViewProps} />
          ) : null}
        </main>

        {mainView === "settings" ? (
          <div className="app-shell__settings-layer">
            <Suspense fallback={null}>
              <LazySettingsScreen
                appearanceController={props.appearanceController}
                desktopApi={desktopApi}
                initialSection={settingsInitialSection}
                profiles={profiles}
                settings={settings}
                onClose={() => setMainView("thread")}
                onOpenMessagingActivity={openMessagingActivityWindow}
              />
            </Suspense>
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
          <Suspense fallback={null}>
            <LazyOnboardingWizard
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
          </Suspense>
        ) : null}

        <CodexConfigWarningBanner desktopApi={desktopApi} />
        <div className="app-toast-stack" aria-live="polite">
          <AppNoticeToast
            desktopApi={desktopApi}
            notice={navigation.archiveThreadNotice}
            onDismiss={navigation.dismissArchiveThreadNotice}
          />
          <AppNoticeToast
            desktopApi={desktopApi}
            notice={composerNotice}
            onDismiss={() => setComposerNotice(undefined)}
          />
          <AppNoticeToast
            desktopApi={desktopApi}
            notice={hotCpuProfileNotice}
            onDismiss={() => setHotCpuProfileNotice(undefined)}
          />
          <AppNoticeToast
            desktopApi={desktopApi}
            notice={backendErrorNotice}
            onDismiss={() => setBackendErrorNotice(undefined)}
          />
          <AppNoticeToast
            desktopApi={desktopApi}
            notice={automationLoadNotice}
            onDismiss={() => setAutomationLoadNotice(undefined)}
          />
          <AppUpdateBanner desktopApi={desktopApi} />
        </div>
      </div>
    </>
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
