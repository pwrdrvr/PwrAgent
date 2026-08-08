import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  buildThreadIdentityKey,
  DEFAULT_BACKGROUND_PR_POLLING,
  DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
  isRemoteFederationTarget,
  parseThreadIdentityKey,
  type AppServerBackendKind,
  type DesktopBootInfo,
  type DesktopCodexProfileModel,
  type DesktopPwrAgentProfileSummary,
  type FederationInstanceId,
  type MessagingChannelKind,
  type NavigationThreadSummary,
  type PrAutoDispatchBudgetStatus,
} from "@pwragent/shared";
import { Sidebar } from "./features/navigation/Sidebar";
import { useThreadJump } from "./features/navigation/useThreadJump";
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
import { useDesktopApplications } from "./lib/useDesktopApplications";
import {
  readRendererFederationLabel,
  readRendererFederationTarget,
} from "./lib/federation-window";
import { useFederationPeerConnectivity } from "./lib/useFederationPeerConnectivity";
import { useFederationThreadEventSubscriptions } from "./lib/useFederationThreadEventSubscriptions";
import { scopeDesktopApiToFederationTarget } from "./lib/federation-desktop-api";
import { federationTargetsEqual } from "./lib/federated-thread-events";
import { useRuntimeIdentity } from "./lib/runtime-identity";
import {
  useNavigationHistory,
  type NavigationHistoryLocation,
} from "./lib/useNavigationHistory";
import { TranscriptLinkProvider } from "./lib/transcript-links";
import { MarkdownRenderingOptionsProvider } from "./lib/markdown-rendering-options";
import { useThreadNavigation } from "./lib/useThreadNavigation";
import { usePwrAgentProfiles } from "./lib/usePwrAgentProfiles";
import { usePullRequestRefresh } from "./features/pr-status/usePullRequestRefresh";
import { useThreadGitWorkingStateRefresh } from "./features/navigation/useThreadGitWorkingStateRefresh";
import { useThreadSessionState } from "./lib/useThreadSessionState";
import { DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT } from "./lib/thread-history-limits";
import { setSidebarResizing } from "./lib/sidebar-resize-signal";
import { useIntegratedTerminals } from "./lib/useIntegratedTerminals";
import { useThreadSkills } from "./lib/useThreadSkills";
import { useQueuedTurnRelease } from "./lib/useQueuedTurnRelease";
import { useScheduledThreadActionProjection } from "./lib/useScheduledThreadActionProjection";
import { useQueuedTurnProjection } from "./lib/useQueuedTurnProjection";
import { useThreadQueuedMessageIndicators } from "./lib/useThreadQueuedMessageIndicators";
import { CodexConfigWarningBanner } from "./features/codex-config/CodexConfigWarningBanner";
import type { AppNoticeToastNotice } from "./features/notifications/AppNoticeToast";
import { AppNoticeStack } from "./features/notifications/AppNoticeStack";
import {
  appNoticeReducer,
  INITIAL_APP_NOTICE_STATE,
} from "./features/notifications/app-notice-state";
import { buildPrAutoDispatchBudgetNotice } from "./features/notifications/pr-auto-dispatch-budget-notice";
import { MessagingErrorNotices } from "./features/notifications/MessagingErrorNotices";
import { buildGithubPrSamlEnforcementNotice } from "./features/notifications/github-pr-saml-notice";
import { buildGithubPrAuthenticationNotice } from "./features/notifications/github-pr-authentication-notice";
import {
  buildHeapSnapshotHandoffMessage,
  describeHeapSnapshotResult,
  HEAP_SNAPSHOT_SECRET_WARNING,
} from "../../shared/heap-snapshot";
import {
  buildHotCpuProfileHandoffMessage,
  formatHotCpuProfileTriggerSummary,
} from "../../shared/hot-cpu-profile";
import {
  githubPrAccessTargetKey,
  type GithubPrAuthenticationFailureEvent,
  type GithubPrSamlEnforcementEvent,
} from "../../shared/github-pr-access";
import { AppUpdateBanner } from "./features/update/AppUpdateBanner";
import { AutomationsScreen } from "./features/automations/AutomationsScreen";
import {
  ThreadSearchPanel,
  useThreadSearchPanelState,
} from "./features/thread-search/ThreadSearchPanel";

const SETTINGS_SECTIONS = new Set<SettingsSection>([
  "general",
  "applications",
  "git",
  "profiles",
  "worktrees",
  "messaging",
  "models",
  "pricing",
  "experimental",
  "about",
]);

const LazySettingsScreen = lazy(async () => ({
  default: (await import("./features/settings/SettingsScreen")).SettingsScreen,
}));

const LazyStarMapScreen = lazy(async () => ({
  default: (await import("./features/star-map/StarMapScreen")).StarMapScreen,
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
  const [revealSelectedThreadRequest, setRevealSelectedThreadRequest] =
    useState(0);
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
    "thread" | "settings" | "automations" | "search" | "star-map"
  >("thread");
  // Star Map floating thread: while the map is up, a clicked local thread
  // elevates the (already mounted) main ThreadView into a floating card
  // over the map instead of remounting a second instance.
  const [starMapFloatOpen, setStarMapFloatOpen] = useState(false);
  const appMainRef = useRef<HTMLElement>(null);
  // Each float session starts at the default position. Without the reset, a
  // drag from the previous session persists in the element's CSS vars and a
  // card once shoved mostly off-screen would reopen unreachable.
  useEffect(() => {
    if (starMapFloatOpen) {
      appMainRef.current?.style.removeProperty("--star-map-float-dx");
      appMainRef.current?.style.removeProperty("--star-map-float-dy");
    }
  }, [starMapFloatOpen]);
  // In-thread find bar (⌘F). `manualFindOpen` is the ⌘F toggle; `findRequest`
  // is a deep-link from a search result (seeded query + its target thread).
  // The bar is open when either applies (see `threadFindOpen` below).
  const [manualFindOpen, setManualFindOpen] = useState(false);
  const [findRequest, setFindRequest] = useState<{
    query: string;
    threadKey: string;
    turnId?: string;
  }>();
  // Bumped on every ⌘F so an already-open find bar takes focus back.
  const [findFocusNonce, setFindFocusNonce] = useState(0);
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
  // Durable notices are retained in arrival order and shown one at a time.
  // This is intentionally a queue rather than one slot per producer: backend
  // failures can arrive while another safety notice is already visible, and
  // every failure must remain individually reviewable and dismissible.
  const [appNotices, dispatchAppNotice] = useReducer(
    appNoticeReducer,
    INITIAL_APP_NOTICE_STATE,
  );
  const showAppNotice = useCallback((notice: AppNoticeToastNotice): void => {
    dispatchAppNotice({ type: "show", notice });
  }, []);
  const dismissAppNotice = useCallback((id: string): void => {
    dispatchAppNotice({ type: "dismiss", id });
  }, []);
  const [githubPrSamlEvents, setGithubPrSamlEvents] =
    useState<GithubPrSamlEnforcementEvent[]>([]);
  const [githubPrAuthenticationFailure, setGithubPrAuthenticationFailure] =
    useState<GithubPrAuthenticationFailureEvent>();
  // Latest thread list, mirrored into a ref so the backend-error toast
  // subscription can resolve a thread's title without re-subscribing on
  // every navigation change. Kept fresh by an effect below, once
  // `navigation` is defined.
  const backendErrorThreadsRef = useRef<NavigationThreadSummary[]>([]);
  const [ThreadViewComponent, setThreadViewComponent] =
    useState<ComponentType<ThreadViewProps>>();
  const desktopApi = props.desktopApi;
  const resumePrAutoDispatchBudget = useCallback(() => {
    void desktopApi?.resumePrAutoDispatchBudget?.()
      .then((status) => {
        if (!status.paused) {
          dispatchAppNotice({
            type: "dismiss-prefix",
            prefix: "pr-auto-dispatch-budget-paused:",
          });
        }
      })
      .catch(() => {
        // Keep the safety notice visible when acknowledgement cannot reach the
        // main process; the operator can try again without losing the stop.
      });
  }, [desktopApi]);
  const showPrAutoDispatchBudgetNotice = useCallback(
    (status: PrAutoDispatchBudgetStatus) => {
      const notice = buildPrAutoDispatchBudgetNotice({
        onLeaveDisabled: () => {
          dispatchAppNotice({
            type: "dismiss-prefix",
            prefix: "pr-auto-dispatch-budget-paused:",
          });
        },
        onResume: resumePrAutoDispatchBudget,
        status,
      });
      if (notice) {
        showAppNotice(notice);
      } else {
        dispatchAppNotice({
          type: "dismiss-prefix",
          prefix: "pr-auto-dispatch-budget-paused:",
        });
      }
    },
    [resumePrAutoDispatchBudget, showAppNotice],
  );
  // Spawning / focusing the Messaging Activity window is fire-and-forget
  // — see `apps/desktop/src/main/messaging-activity-window.ts`. The
  // main window stays where it was; the activity surface gets its own
  // OS window with its own lifecycle.
  const openMessagingActivityWindow = useCallback(() => {
    void desktopApi?.openMessagingActivityWindow?.();
  }, [desktopApi]);
  const openMessagingSettings = useCallback(() => {
    setSettingsInitialSection("messaging");
    setMainView("settings");
  }, []);
  const dismissGithubPrSamlNotice = useCallback(() => {
    dispatchAppNotice({ type: "dismiss-prefix", prefix: "github-pr-saml:" });
    setGithubPrSamlEvents((current) => current.slice(1));
  }, []);
  const openGitSettings = useCallback(() => {
    dismissGithubPrSamlNotice();
    dispatchAppNotice({
      type: "dismiss-prefix",
      prefix: "github-pr-authentication-failure",
    });
    setGithubPrAuthenticationFailure(undefined);
    setSettingsInitialSection("git");
    setMainView("settings");
  }, [dismissGithubPrSamlNotice]);
  const githubPrSamlNotice = useMemo(() => {
    const event = githubPrSamlEvents[0];
    return event
      ? buildGithubPrSamlEnforcementNotice({
          event,
          onDismiss: dismissGithubPrSamlNotice,
          onOpenGitSettings: openGitSettings,
        })
      : undefined;
  }, [dismissGithubPrSamlNotice, githubPrSamlEvents, openGitSettings]);

  useEffect(() => {
    if (githubPrSamlNotice) showAppNotice(githubPrSamlNotice);
  }, [githubPrSamlNotice, showAppNotice]);

  const dismissGithubPrAuthenticationNotice = useCallback(() => {
    dispatchAppNotice({
      type: "dismiss-prefix",
      prefix: "github-pr-authentication-failure",
    });
    setGithubPrAuthenticationFailure(undefined);
  }, []);
  const githubPrAuthenticationNotice = useMemo(() => {
    return githubPrAuthenticationFailure
      ? buildGithubPrAuthenticationNotice({
          event: githubPrAuthenticationFailure,
          onDismiss: dismissGithubPrAuthenticationNotice,
          onOpenGitSettings: openGitSettings,
        })
      : undefined;
  }, [
    dismissGithubPrAuthenticationNotice,
    githubPrAuthenticationFailure,
    openGitSettings,
  ]);

  useEffect(() => {
    if (githubPrAuthenticationNotice) {
      showAppNotice(githubPrAuthenticationNotice);
    }
  }, [githubPrAuthenticationNotice, showAppNotice]);

  const syncMessagingErrorNotice = useCallback((
    platform: MessagingChannelKind,
    notice: AppNoticeToastNotice | undefined,
  ): void => {
    if (notice) {
      showAppNotice(notice);
      return;
    }
    dispatchAppNotice({
      type: "dismiss-prefix",
      prefix: `messaging-platform-error:${platform}:`,
    });
  }, [showAppNotice]);

  useEffect(() => {
    return desktopApi?.onGithubPrSamlEnforcement?.((event) => {
      setGithubPrSamlEvents((current) => {
        const eventKey = githubPrAccessTargetKey(event.target);
        return current.some(
          (queued) => githubPrAccessTargetKey(queued.target) === eventKey,
        )
          ? current
          : [...current, event];
      });
    });
  }, [desktopApi]);

  useEffect(() => {
    return desktopApi?.onGithubPrAuthenticationFailure?.((event) => {
      setGithubPrAuthenticationFailure(event);
    });
  }, [desktopApi]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = desktopApi?.onPrAutoDispatchBudgetChanged?.((status) => {
      if (!cancelled) showPrAutoDispatchBudgetNotice(status);
    });
    void desktopApi?.getPrAutoDispatchBudgetStatus?.()
      .then((status) => {
        if (!cancelled) showPrAutoDispatchBudgetNotice(status);
      })
      .catch(() => {
        // Best effort only. A later budget event will still surface the stop.
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi, showPrAutoDispatchBudgetNotice]);

  useEffect(() => {
    return desktopApi?.onHotCpuProfileCaptured?.((event) => {
      const heapSnapshotCount = event.heapSnapshotArtifacts?.length ?? 0;
      const heapSnapshotSummary =
        heapSnapshotCount > 0
          ? ` ${heapSnapshotCount} heap snapshots captured.`
          : "";
      showAppNotice({
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
  }, [desktopApi, showAppNotice]);

  // On-demand heap snapshots. The capture (and its countdown) run in main, so
  // the result can land here even if Settings was closed to stage the scenario.
  useEffect(() => {
    return desktopApi?.onHeapSnapshotCaptured?.((result) => {
      const failed = result.artifacts.length === 0;
      // A capture can half-succeed (main written, renderer window gone). Saying
      // "captured" and hiding the errors would send someone off to analyze a
      // snapshot that is missing the half they cared about.
      const partial = !failed && result.errors.length > 0;
      const title = failed
        ? "Heap snapshot failed"
        : partial
          ? "Heap snapshot partially captured"
          : "Heap snapshot captured";
      const message = failed
        ? result.errors.join("; ")
        : [
            describeHeapSnapshotResult(result),
            partial ? ` Not captured: ${result.errors.join("; ")}.` : "",
            ` ${HEAP_SNAPSHOT_SECRET_WARNING}`,
          ].join("");
      showAppNotice({
        autoDismiss: false,
        copyText: buildHeapSnapshotHandoffMessage(result),
        detail: failed ? undefined : `Session: ${result.sessionDirectoryName}`,
        id: `heap-snapshot:${result.capturedAt}`,
        title,
        message,
      });
    });
  }, [desktopApi, showAppNotice]);

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
        showAppNotice({
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
  }, [desktopApi, showAppNotice]);

  // Surface backend turn failures + system errors as a durable toast. The
  // matching transcript entry (rendered from the thread overlay's
  // turnFailureLog) is the in-context record; this toast is the window-scoped
  // "something just broke" signal that has to be acknowledged.
  // Notices are keyed by thread and queued so a failure on one thread can't
  // suppress a signal from another.
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
      if (
        !federationTargetsEqual(
          event.federationTarget,
          readRendererFederationTarget(),
        )
      ) {
        return;
      }
      const instanceId = event.federationTarget?.scope === "remote"
        ? event.federationTarget.instanceId
        : undefined;
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
        dispatchAppNotice({
          type: "backend-error",
          signal: {
            kind: "turn-failed",
            backend: event.backend,
            threadId: params.threadId ?? "unknown",
            turnId: params.turnId ?? "unknown",
            errorMessage,
            ...(instanceId ? { instanceId } : {}),
            threadLabel: labelForThread(event.backend, params.threadId),
          },
        });
        return;
      }
      if (
        event.notification.method
        === "thread/codexInvalidIdRecovery/updated"
      ) {
        const params = event.notification.params as {
          threadId: string;
          turnId?: string;
          status: "repairing" | "succeeded" | "failed";
          failureMessage: string;
          recoveryError?: string;
        };
        dispatchAppNotice({
          type: "backend-error",
          signal: {
            kind: "codex-invalid-id-recovery",
            failureMessage: params.failureMessage,
            ...(instanceId ? { instanceId } : {}),
            recoveryError: params.recoveryError,
            status: params.status,
            threadId: params.threadId,
            threadLabel: labelForThread("codex", params.threadId),
            turnId: params.turnId ?? "unknown",
          },
        });
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
        dispatchAppNotice({
          type: "backend-error",
          signal: {
            kind: "system-error",
            backend: event.backend,
            ...(instanceId ? { instanceId } : {}),
            threadId: params.threadId ?? "unknown",
            threadLabel: labelForThread(event.backend, params.threadId),
          },
        });
        return;
      }
    });
  }, [desktopApi]);
  // `instant` is for callers that are about to hide the sidebar (the ⌘K peek):
  // a smooth scroll is animated over several frames, and hiding the sidebar
  // mid-animation abandons it wherever it got to. An instant scroll lands in one
  // frame, and Chromium keeps the offset across `display: none` — so the row is
  // already centered when the sidebar comes back.
  //
  // Takes an options object rather than a bare `behavior` string so a caller
  // that wires this straight to an event handler (which would pass the event as
  // the first argument) still gets the default.
  const revealSelectedThreadInList = useCallback(
    (options?: { instant?: boolean }) => {
      // A selected row can be unmounted behind a collapsed directory,
      // Directory threads divider, overflow cap, or parent-thread group. The
      // request nonce lets the active sidebar lens open those containers
      // before ThreadRow's mount effect performs the final nearest-edge
      // scroll. Keep the direct query for the common already-visible case so
      // title clicks retain their centered smooth-scroll behavior.
      setRevealSelectedThreadRequest((current) => current + 1);
      const selectedRow = document.querySelector<HTMLElement>(
        ".sidebar .thread-row.is-selected",
      );
      selectedRow?.scrollIntoView({
        behavior: options?.instant === true ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    },
    [],
  );
  const settings = props.settings;

  // Persisted layout setters — update local state immediately and write the
  // new value to config.toml's [ui] section so it survives a relaunch. The
  // writeConfig call is fire-and-forget; a failed write just means the
  // preference isn't remembered next launch.
  const writeConfig = settings.writeConfig;
  // Thread-list quick search (⌘K anywhere, ⌘F while the sidebar is focused).
  // Owns its own open state and the sidebar peek it needs to render.
  const threadJump = useThreadJump({ sidebarHidden, setSidebarHidden });
  const endSidebarPeek = threadJump.endPeek;
  const setSidebarHiddenPersisted = useCallback(
    (next: boolean) => {
      // An explicit toggle (⌘B, the chips) is the operator stating a preference,
      // so it ends any quick-search peek in flight.
      endSidebarPeek();
      setSidebarHidden(next);
      void writeConfig({ ui: { sidebarHidden: next } });
    },
    [endSidebarPeek, writeConfig],
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
  const scheduledActionFederationTargets = useFederationThreadEventSubscriptions({
    desktopApi,
    enabled: !readRendererFederationTarget(),
    selectedThread: navigation.selectedThread,
    threads: navigation.threads,
  });
  const selectedThreadFederationTarget =
    navigation.selectedThread?.federation?.ref.target;
  const navigationFederationTarget = navigation.federationTarget;
  const remoteApplicationInstanceId =
    selectedThreadFederationTarget
    && isRemoteFederationTarget(selectedThreadFederationTarget)
      ? selectedThreadFederationTarget.instanceId
      : navigationFederationTarget
        && isRemoteFederationTarget(navigationFederationTarget)
        ? navigationFederationTarget.instanceId
        : readRendererFederationTarget()?.instanceId;
  const activeFederationTarget = useMemo(
    () => remoteApplicationInstanceId
      ? { scope: "remote" as const, instanceId: remoteApplicationInstanceId }
      : undefined,
    [remoteApplicationInstanceId],
  );
  const activeFederationOwnerLabel = activeFederationTarget
    ? navigation.selectedThread?.federation?.instanceLabel
      ?? navigation.threads.find((thread) => {
        const target = thread.federation?.ref.target;
        return target
          && isRemoteFederationTarget(target)
          && target.instanceId === activeFederationTarget.instanceId;
      })?.federation?.instanceLabel
      ?? readRendererFederationLabel()
      ?? "the remote machine"
    : undefined;
  const threadDesktopApi = useMemo(
    () => scopeDesktopApiToFederationTarget(desktopApi, activeFederationTarget),
    [activeFederationTarget, desktopApi],
  );
  const peerConnectivity = useFederationPeerConnectivity({
    desktopApi,
    target: activeFederationTarget,
  });
  const applications = useDesktopApplications({
    desktopApi,
    localApplications: settings.snapshot?.applications,
    remoteInstanceId: remoteApplicationInstanceId,
  });
  // Keep the backend-error toast's thread lookup fresh without making the
  // toast subscription depend on (and re-subscribe to) the thread list.
  useEffect(() => {
    backendErrorThreadsRef.current = navigation.threads;
  }, [navigation.threads]);
  const backendSummaries = useBackendSummaries(desktopApi, {
    enabled: normalAppEnabled,
    federationTarget: activeFederationTarget,
    suspended: !peerConnectivity.connected,
  });
  const refreshAcpAgents = backendSummaries.refreshAcpAgents;
  const refreshSelectedAcpProvider = useCallback(
    async (
      backend: AppServerBackendKind,
    ) => {
      if (!backend.startsWith("acp:")) {
        return undefined;
      }
      const refreshedBackends = await refreshAcpAgents();
      return refreshedBackends.find((candidate) => candidate.kind === backend);
    },
    [refreshAcpAgents],
  );
  const pullRequests = usePullRequestRefresh({
    desktopApi,
    onRefreshNavigation: navigation.refresh,
    selectedThread: navigation.selectedThread,
  });
  const gitWorkingState = useThreadGitWorkingStateRefresh({
    desktopApi,
    selectedThread: navigation.selectedThread,
  });
  // Browser-style back/forward across threads, project launchpads, and the
  // search view. Settings and Automations stay untracked because they're
  // modal-ish chrome. Search query/results live up here so Back lands on a
  // still-populated results list after opening a result unmounts the panel.
  const threadSearchState = useThreadSearchPanelState();
  const historyLocation = useMemo<NavigationHistoryLocation | undefined>(() => {
    if (mainView === "search") {
      return { view: "search" };
    }
    if (mainView === "thread" && navigation.selectedLaunchpad) {
      return {
        view: "launchpad",
        directoryKey: navigation.selectedLaunchpad.directoryKey,
      };
    }
    if (mainView === "thread" && navigation.selectedThreadKey) {
      return { view: "thread", threadKey: navigation.selectedThreadKey };
    }
    return undefined;
  }, [mainView, navigation.selectedLaunchpad, navigation.selectedThreadKey]);
  const showThread = navigation.showThread;
  const selectDirectoryLaunchpad = navigation.selectDirectoryLaunchpad;
  // Target of `pwragent://thread/…` chips in the transcript. Navigation-only:
  // the scheme never carries an action, so this is the entire surface it can
  // reach. Mirrors the tray/notification `onShowThreadRequested` path below.
  const showThreadFromLink = useCallback(
    (request: {
      backend: AppServerBackendKind;
      instanceId?: FederationInstanceId;
      threadId: string;
    }): void => {
      if (request.instanceId) {
        const windowTarget = readRendererFederationTarget();
        if (windowTarget?.instanceId !== request.instanceId) {
          const target = {
            scope: "remote" as const,
            instanceId: request.instanceId,
          };
          void desktopApi?.openFederationWindow?.({
            target,
            initialThread: {
              backend: request.backend,
              target,
              threadId: request.threadId,
            },
          });
          return;
        }
      }
      setMainView("thread");
      void showThread({ backend: request.backend, threadId: request.threadId });
    },
    [desktopApi, showThread],
  );
  const restoreHistoryLocation = useCallback(
    (location: NavigationHistoryLocation): void => {
      if (location.view === "search") {
        setMainView("search");
        return;
      }
      setMainView("thread");
      if (location.view === "launchpad") {
        selectDirectoryLaunchpad(location.directoryKey);
        return;
      }
      const parts = parseThreadIdentityKey(location.threadKey);
      if (parts) {
        void showThread(parts);
      }
    },
    [selectDirectoryLaunchpad, showThread],
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
  const liveLaunchpadKeys = useMemo<ReadonlySet<string> | undefined>(
    () =>
      navigation.loaded
        ? new Set(
            navigation.directories
              .filter((directory) => directory.launchpad)
              .map((directory) => directory.key),
          )
        : undefined,
    [navigation.directories, navigation.loaded],
  );
  const history = useNavigationHistory({
    current: historyLocation,
    liveLaunchpadKeys,
    liveThreadKeys,
    restore: restoreHistoryLocation,
  });
  useHistoryNavHotkeys({ onBack: history.goBack, onForward: history.goForward });
  // ⌘⇧F / ⌃⇧F opens the global thread search screen; ⌘F is the focus-sensitive
  // context find; ⌘K always lands on the thread-list quick search.
  useFindHotkeys({
    onOpenSearch: () => setMainView(mainView === "search" ? "thread" : "search"),
    onFind: () => {
      // The thread-list quick search claims ⌘F while the sidebar is focused;
      // anywhere else ⌘F finds within the open thread. Focus decides — which is
      // precisely why ⌘K exists: reaching for the thread list from inside a
      // thread would otherwise open the in-thread find.
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".sidebar")) {
        threadJump.openJump();
        return;
      }
      if (mainView === "thread") {
        setManualFindOpen(true);
        // Re-arm focus: a second ⌘F with the bar already open (operator clicked
        // into the transcript, then reached back for find) must put the caret
        // back in the field, the way a browser's find does.
        setFindFocusNonce((nonce) => nonce + 1);
      }
    },
    // ⌘K toggles, like ⌘⇧F toggles the search screen: pressing it again backs
    // out of a jump you didn't mean to start, without reaching for Escape.
    onThreadJump: threadJump.toggleJump,
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
  useQueuedTurnProjection({
    composerDraftStore,
    threads: navigation.threads,
  });
  const scheduledActionProjectionSources = useMemo(
    () => readRendererFederationTarget()
      ? [{
          federationTarget: activeFederationTarget,
          suspended: !peerConnectivity.connected,
        }]
      : [
          { federationTarget: undefined },
          ...scheduledActionFederationTargets.map((federationTarget) => ({
            federationTarget,
          })),
        ],
    [
      activeFederationTarget,
      peerConnectivity.connected,
      scheduledActionFederationTargets,
    ],
  );
  useScheduledThreadActionProjection({
    composerDraftStore,
    desktopApi,
    onThreadLifecycleChanged: navigation.refresh,
    sources: scheduledActionProjectionSources,
  });
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
  // Per-thread "Scheduled"/"Queued" chip state, derived from the same
  // queued-turn store useQueuedTurnRelease drains. Keyed by thread identity
  // key so it threads down beside approvalRequestThreadKeys.
  const queuedMessageThreadKeys = useThreadQueuedMessageIndicators({
    composerDraftStore,
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
  const session = useThreadSessionState({
    desktopApi,
    initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
    liveTranscriptEventFiltering:
      settings.snapshot?.experimental.liveTranscriptEventFiltering?.value ?? false,
    thread: loadThreadDetail ? navigation.selectedThread : undefined,
  });
  const skills = useThreadSkills({
    desktopApi,
    launchpad: navigation.selectedLaunchpad,
    thread: loadThreadDetail ? navigation.selectedThread : undefined,
  });
  // Lives here, not in ThreadView: ThreadView unmounts on the search view and
  // on any refresh that flips `threadDetailPending`, and terminal state kept
  // inside it left the main process's PTYs running with nothing in the UI
  // pointing at them.
  const terminals = useIntegratedTerminals(desktopApi);
  // Sidebar rows wear a terminal chip when a shell is alive for that thread —
  // without it, a collapsed terminal is unfindable from the thread list.
  const terminalThreadKeys = useMemo(
    () =>
      Object.fromEntries(
        [...terminals.liveThreadKeys].map((threadKey) => [threadKey, true]),
      ),
    [terminals.liveThreadKeys],
  );
  // Window-level masthead actions (Automations / Settings / New Thread).
  // Shared by the sidebar masthead's home (AppTitleBar on Windows) and the
  // thread-header relocation when the sidebar is hidden on macOS/Linux.
  const addProjectDirectory = async (): Promise<void> => {
    setMainView("thread");
    // The hidden-sidebar masthead is the only visible home for this action in
    // that layout. Restore the sidebar before opening the picker so either the
    // newly registered directory or a validation error has a visible result.
    if (sidebarHidden) {
      setSidebarHiddenPersisted(false);
    }
    await navigation.addProjectDirectory();
  };
  const mastheadActions = {
    addingProjectDirectory: navigation.pickingDirectory,
    automationsActive: mainView === "automations",
    settingsActive: mainView === "settings",
    threadSearchActive: mainView === "search",
    creatingThread: Boolean(navigation.creatingThread),
    newThreadDirectoryLabel: navigation.newThreadDirectoryLabel,
    onAddProjectDirectory: readRendererFederationTarget()
      ? undefined
      : addProjectDirectory,
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
  // The Star Map is a whole-federation surface owned by the primary window;
  // federation remote-viewer windows never render its toggle.
  const starMapControls = readRendererFederationTarget()
    ? undefined
    : {
        active: mainView === "star-map",
        onToggle: () => {
          setStarMapFloatOpen(false);
          setMainView(mainView === "star-map" ? "thread" : "star-map");
        },
      };
  const closeStarMap = () => {
    setStarMapFloatOpen(false);
    setMainView("thread");
  };
  const threadViewProps = {
    activeFederationOwnerLabel,
    activeFederationTarget,
    activeTurnId: session.activeTurnId,
    activeTurnStartedAt: session.activeTurnStartedAt,
    terminals,
    addOptimisticReviewEntry: session.addOptimisticReviewEntry,
    addOptimisticUserMessage: session.addOptimisticUserMessage,
    backendError: backendSummaries.error,
    backends: backendSummaries.backends,
    applications,
    codexFastAllowed:
      settings.snapshot?.models?.codex.allowFast?.value ?? true,
    providerModelDefaults: settings.snapshot?.models?.providerDefaults,
    providerThreadMigrations:
      settings.snapshot?.models?.providerThreadMigrations,
    archiveThreadError: navigation.archiveThreadError,
    clearPendingRequest: session.clearPendingRequest,
    composerDisabled:
      !navigation.selectedThread ||
      // A remote thread cannot accept input while its owning instance is
      // unreachable — typing would only queue into a dead RPC.
      !peerConnectivity.connected ||
      !backendSummaries.backends.some(
        (backend) =>
          backend.kind === navigation.selectedThread?.source &&
          backend.available
      ),
    composerImplementation: settings.composerImplementation,
    composerDraftStore,
    desktopApi: threadDesktopApi,
    launchpadError: navigation.launchpadError,
    onProviderSelected: refreshSelectedAcpProvider,
    onShowNotice: showAppNotice,
    loading: session.loading,
    loadingMore: session.loadingMore,
    messageCount: session.messages.length,
    contextWindow: session.contextWindow,
    pricing: session.response?.pricing,
    toolAccounting:
      settings.snapshot?.experimental.threadToolAccounting?.value === true
        ? session.response?.toolAccounting
        : undefined,
    threadPricingSummaryEnabled:
      settings.snapshot?.experimental.threadPricingSummary?.value ?? true,
    pricingDisplayOptions: {
      codexCredits:
        settings.snapshot?.experimental.threadPricingDisplayCodexCredits?.value ??
        false,
      usd: settings.snapshot?.experimental.threadPricingDisplayUsd?.value ?? true,
    },
    pendingAssistantMessage: session.pendingAssistantMessage,
    transientMessage: session.transientMessage,
    transientMessages: session.transientMessages,
    pendingMcpInteraction: session.pendingMcpInteraction,
    pendingRequest: session.pendingRequest,
    pendingUserInput: session.pendingUserInput,
    pendingStatusText: session.pendingStatusText,
    runningTurnUsageText: session.runningTurnUsageText,
    threadBusy: session.threadBusy,
    pastedImageMaxPatches:
      settings.snapshot?.imageUploads.pastedImageMaxPatches.value,
    pdfAnalysisEnabled: settings.snapshot?.general.pdfAnalysisEnabled?.value,
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
    threads: navigation.threads,
    suppressBranchDriftDialog: mainView === "settings",
    directories: navigation.directories,
    fullAccessRiskWarningDismissed:
      settings.snapshot?.experimental.fullAccessRiskWarningDismissed.value ?? false,
    backgroundPrPollingEnabled:
      settings.snapshot
        ? settings.snapshot.git?.backgroundPrPolling?.value
          ?? DEFAULT_BACKGROUND_PR_POLLING
        : false,
    prAutoDispatchAllowed:
      settings.snapshot
        ? settings.snapshot.git?.prAutoDispatchAllowed?.value
          ?? DEFAULT_PR_AUTO_DISPATCH_ALLOWED
        : false,
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
    onPickDirectoryForReference: () => navigation.pickDirectoryForReference(),
    onAttachDirectoryReferences: (
      paths: string[],
      target: { backend: AppServerBackendKind; threadId: string }
    ) => {
      void navigation.attachDirectoryPathsToThread(target, paths);
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
    expandedTranscriptActivityIds: session.expandedTranscriptActivityIds,
    expandedTranscriptWorkPhaseGroupIds:
      session.expandedTranscriptWorkPhaseGroupIds,
    renderedTranscriptEntryLimit: session.renderedTranscriptEntryLimit,
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
    onOpenMessagingSettings: openMessagingSettings,
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
    starMap: starMapControls,
    findOpen: threadFindOpen,
    findInitialQuery: threadFindInitialQuery,
    findTurnId: threadFindTurnId,
    findFocusNonce,
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
    onCancelLaunchpad: (directoryKey) => {
      const restoredSourceThread = navigation.discardLaunchpad(directoryKey);
      if (!restoredSourceThread) {
        history.goBack();
      }
    },
    // The composer's 5th argument is `extraDirectoryPaths` (draft
    // `@`-references); the hook's 5th is `parentThreadId` (resolved from
    // the launchpad draft internally), so map positions explicitly.
    onMaterializeLaunchpad: (
      directoryKey,
      input,
      collaborationMode,
      reviewTarget,
      extraDirectoryPaths,
      scheduledFor,
    ) =>
      navigation.materializeDirectoryLaunchpad(
        directoryKey,
        input,
        collaborationMode,
        reviewTarget,
        undefined,
        extraDirectoryPaths,
        scheduledFor,
      ),
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
    onSetThreadPrAutoDispatch: navigation.selectedThread
      ? async (enabled) =>
          await navigation.setThreadPrAutoDispatch(
            navigation.selectedThread!,
            enabled,
          )
      : undefined,
    onCancelThreadPrAutoDispatch: navigation.selectedThread
      ? async (fingerprint) =>
          await navigation.cancelThreadPrAutoDispatch(
            navigation.selectedThread!,
            fingerprint,
          )
      : undefined,
    onSendThreadPrAutoDispatchNow: navigation.selectedThread
      ? async (fingerprint) =>
          await navigation.sendThreadPrAutoDispatchNow(
            navigation.selectedThread!,
            fingerprint,
          )
      : undefined,
    onRestoreWorktree: navigation.restoreWorktree,
    onTranscriptViewportChange: session.setViewport,
    onExpandedTranscriptActivityIdsChange:
      session.setExpandedTranscriptActivityIds,
    onExpandedTranscriptWorkPhaseGroupIdsChange:
      session.setExpandedTranscriptWorkPhaseGroupIds,
    onRenderedTranscriptEntryLimitChange:
      session.setRenderedTranscriptEntryLimit,
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
    <TranscriptLinkProvider
      activeThread={navigation.selectedThread}
      onShowThread={showThreadFromLink}
      threads={navigation.threads}
    >
      <AppTitleBar
        desktopApi={desktopApi}
        onOpenMessagingActivity={openMessagingActivityWindow}
        onOpenMessagingSettings={openMessagingSettings}
        layout={{
          sidebarOpen: !sidebarHidden,
          railOpen: contextRailPinned,
          onToggleSidebar: () => setSidebarHiddenPersisted(!sidebarHidden),
          onToggleRail: () => setContextRailPinnedPersisted(!contextRailPinned),
        }}
        starMap={starMapControls}
        actions={mastheadActions}
      />
      <div
        ref={appShellRef}
        className="app-shell"
        data-sidebar-hidden={sidebarHidden ? "true" : undefined}
        style={{ "--sidebar-width": `${sidebarWidthRef.current}px` } as CSSProperties}
      >
        <Sidebar
          addingProjectDirectory={navigation.pickingDirectory}
          backends={backendSummaries.backends}
          browseMode={navigation.browseMode}
          createThreadError={navigation.createThreadError}
          pickDirectoryError={navigation.pickDirectoryError}
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
          loaded={navigation.loaded}
          loading={navigation.loading}
          approvalRequestThreadKeys={session.approvalRequestThreadKeys}
          inputRequestThreadKeys={session.inputRequestThreadKeys}
          terminalThreadKeys={terminalThreadKeys}
          queuedMessageThreadKeys={queuedMessageThreadKeys}
          composerSourceThreadKey={navigation.composerSourceThreadKey}
          revealSelectedThreadRequest={revealSelectedThreadRequest}
          onRevealSelectedThreadComplete={threadJump.completePeekRestore}
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
          onAddProjectDirectory={readRendererFederationTarget()
            ? undefined
            : addProjectDirectory}
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
          threadJumpOpen={threadJump.open}
          onThreadJumpOpenChange={(open) => {
            // Every close (Escape, outside click, picking a thread) goes through
            // closeJump so a peeked-open sidebar goes back to hidden.
            if (open) {
              threadJump.openJump();
              return;
            }
            threadJump.closeJump();
          }}
          onJumpToThread={(thread) => {
            setMainView("thread");
            navigation.selectThread(thread);
            // Reveal on the next frame, once the new selection has rendered.
            // Do it even when the sidebar is only peeked open (⌘K over a hidden
            // sidebar). Hidden rows reveal asynchronously as their collapsed
            // containers reopen, so keep a peek laid out until ThreadRow reports
            // that the selected row mounted and scrolled. The offset survives
            // restoring the hidden preference, and an instant scroll avoids
            // dismissing the peek partway through an animation.
            const instant = threadJump.isPeeking();
            if (instant) {
              threadJump.deferPeekRestore();
            }
            requestAnimationFrame(() => revealSelectedThreadInList({ instant }));
          }}
          onJumpToRemoteThread={(thread) => {
            const ref = thread.federation?.ref;
            if (!ref) {
              return;
            }
            // Pin first (viewer-owned overlay row), then refresh so the
            // merged snapshot carries the new row, then select it — the
            // selection scopes ThreadView's IPC to the owning instance via
            // selectedThreadFederationTarget.
            const instant = threadJump.isPeeking();
            if (instant) {
              threadJump.deferPeekRestore();
            }
            void (async () => {
              try {
                await desktopApi?.addRemoteThreadPin?.({
                  ref,
                  summary: thread,
                  instanceLabel: thread.federation?.instanceLabel,
                });
              } catch (error) {
                console.warn("Pinning the remote thread failed.", error);
              }
              await navigation.refresh();
              setMainView("thread");
              navigation.selectThread(thread);
              requestAnimationFrame(() =>
                revealSelectedThreadInList({ instant }),
              );
            })();
          }}
          onRemoveRemoteThreadPin={async (thread) => {
            const ref = thread.federation?.ref;
            if (!ref) {
              return;
            }
            try {
              await desktopApi?.removeRemoteThreadPin?.({ ref });
            } catch (error) {
              console.warn("Removing the remote thread pin failed.", error);
            }
            await navigation.refresh();
          }}
          onArchiveThread={navigation.archiveThread}
          onMarkThreadsSeen={
            desktopApi?.markThreadSeen ? navigation.markThreadsSeen : undefined
          }
          onMarkThreadUnread={
            desktopApi?.markThreadSeen ? navigation.markThreadUnread : undefined
          }
          onRenameThread={navigation.renameThread}
          onSetThreadReaction={navigation.setThreadReaction}
          onSetThreadPin={navigation.setThreadPin}
          onReorderThreadPins={navigation.reorderThreadPins}
          onSetThreadParent={navigation.setThreadParent}
          onUpdateSubthreadOrder={navigation.updateSubthreadOrder}
          onSetSubthreadsCollapsed={navigation.setSubthreadsCollapsed}
          onSetDirectoryPin={navigation.setDirectoryPin}
          onReorderDirectoryPins={navigation.reorderDirectoryPins}
          onSetDirectoryThreadsCollapsed={
            navigation.setDirectoryThreadsCollapsed
          }
          onRemoveDirectory={(directory) => {
            void navigation.removeDirectory(directory.key);
          }}
          onPrefetchPullRequests={pullRequests.prefetch}
          onPrefetchGitWorkingState={gitWorkingState.prefetch}
          onDetachPullRequest={async (thread, pr) => {
            if (!desktopApi?.detachThreadPullRequest) return;
            await desktopApi.detachThreadPullRequest({
              backend: thread.source,
              // Remote threads detach on their owning instance; without
              // the target the write lands in the viewer's overlay store
              // and reverts on the next remote snapshot.
              federationTarget: thread.federation?.ref.target ??
                readRendererFederationTarget(),
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
          ref={appMainRef}
          className={`app-main${
            threadDetailPending ? " app-main--thread-detail-pending" : ""
          }${
            mainView === "star-map" && starMapFloatOpen
              ? " app-main--star-map-float"
              : ""
          }`}
        >
          {mainView === "star-map" && starMapFloatOpen ? (
            <div
              className="star-map-float-handle"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if (
                  event.target instanceof HTMLElement
                  && event.target.closest("button")
                ) {
                  return;
                }
                const main = event.currentTarget.closest("main");
                if (!(main instanceof HTMLElement)) return;
                event.preventDefault();
                const startX = event.clientX;
                const startY = event.clientY;
                const baseX =
                  Number.parseFloat(
                    main.style.getPropertyValue("--star-map-float-dx"),
                  ) || 0;
                const baseY =
                  Number.parseFloat(
                    main.style.getPropertyValue("--star-map-float-dy"),
                  ) || 0;
                // Clamp drags so a strip of the card (and its handle row)
                // always stays on-screen — an off-screen float has no other
                // recovery affordance.
                const MIN_VISIBLE_PX = 160;
                const rect = main.getBoundingClientRect();
                const untranslatedLeft = rect.left - baseX;
                const untranslatedTop = rect.top - baseY;
                const clampDx = (dx: number) =>
                  Math.min(
                    Math.max(dx, MIN_VISIBLE_PX - untranslatedLeft - rect.width),
                    window.innerWidth - MIN_VISIBLE_PX - untranslatedLeft,
                  );
                const clampDy = (dy: number) =>
                  Math.min(
                    Math.max(dy, -untranslatedTop),
                    window.innerHeight - MIN_VISIBLE_PX - untranslatedTop,
                  );
                let lastDx = baseX;
                let lastDy = baseY;
                let frame = 0;
                const move = (pointerEvent: globalThis.PointerEvent) => {
                  lastDx = clampDx(baseX + pointerEvent.clientX - startX);
                  lastDy = clampDy(baseY + pointerEvent.clientY - startY);
                  if (!frame) {
                    frame = requestAnimationFrame(() => {
                      frame = 0;
                      main.style.setProperty("--star-map-float-dx", `${lastDx}px`);
                      main.style.setProperty("--star-map-float-dy", `${lastDy}px`);
                    });
                  }
                };
                const stop = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", stop);
                  window.removeEventListener("pointercancel", stop);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", stop);
                window.addEventListener("pointercancel", stop);
              }}
            >
              <span className="star-map-float-handle__grip" aria-hidden="true" />
              <span className="star-map-float-handle__title">
                {navigation.selectedThread?.title ?? ""}
              </span>
              <button
                type="button"
                className="star-map-float-handle__close"
                onClick={() => setStarMapFloatOpen(false)}
              >
                Back to map
              </button>
            </div>
          ) : null}
          {!peerConnectivity.connected ? (
            // The runtime keeps reconnecting on its own; this banner
            // explains why the window went read-only (composer disabled,
            // remote polling suspended) instead of leaving a half-dead
            // surface that fails silently.
            <div className="federation-disconnected-banner" role="alert">
              <span className="federation-disconnected-banner__dot" aria-hidden="true" />
              {`${readRendererFederationLabel() ?? "Remote instance"} is unreachable — reconnecting. Threads shown may be stale.`}
            </div>
          ) : null}
          {mainView === "search" ? (
            <ThreadSearchPanel
              desktopApi={desktopApi}
              onOpenMessagingActivity={openMessagingActivityWindow}
              onOpenMessagingSettings={openMessagingSettings}
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
                if (
                  result.federation &&
                  isRemoteFederationTarget(result.federation.ref.target)
                ) {
                  await desktopApi?.openFederationWindow?.({
                    target: result.federation.ref.target,
                    initialThread: result.federation.ref,
                  });
                  return;
                }
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
                onOpenMessagingSettings={openMessagingSettings}
                layout={{
                  sidebarOpen: !sidebarHidden,
                  railOpen: contextRailPinned,
                  onToggleSidebar: () => setSidebarHiddenPersisted(!sidebarHidden),
                  onToggleRail: () => setContextRailPinnedPersisted(!contextRailPinned),
                }}
                masthead={mastheadActions}
                history={historyNav}
                starMap={starMapControls}
              />
            </section>
          ) : ThreadViewComponent ? (
            <MarkdownRenderingOptionsProvider
              mathEnabled={
                settings.snapshot?.experimental.markdownMathRendering?.value ?? false
              }
            >
              <ThreadViewComponent {...threadViewProps} />
            </MarkdownRenderingOptionsProvider>
          ) : null}
        </main>

        {mainView === "settings" ? (
          <div className="app-shell__settings-layer">
            <Suspense fallback={null}>
              <LazySettingsScreen
                appearanceController={props.appearanceController}
                cachedBackends={backendSummaries.backends}
                desktopApi={desktopApi}
                initialSection={settingsInitialSection}
                profiles={profiles}
                settings={settings}
                onClose={() => setMainView("thread")}
                onOpenMessagingActivity={openMessagingActivityWindow}
                onOpenThread={(target) => {
                  setMainView("thread");
                  void navigation.showThread(target);
                }}
              />
            </Suspense>
          </div>
        ) : null}

        {mainView === "star-map" ? (
          <div
            className={`app-shell__star-map-layer${
              starMapFloatOpen ? " is-floating" : ""
            }`}
          >
            <Suspense fallback={null}>
              <LazyStarMapScreen
                desktopApi={desktopApi}
                localThreads={navigation.threads}
                sessionKeys={{
                  approvalRequestThreadKeys: session.approvalRequestThreadKeys,
                  inputRequestThreadKeys: session.inputRequestThreadKeys,
                  thinkingThreadKeys: session.thinkingThreadKeys,
                }}
                localInstanceLabel={
                  settings.snapshot?.federation.instanceLabel.value
                }
                floating={starMapFloatOpen}
                onClose={closeStarMap}
                onOpenLocalThread={(thread) => {
                  navigation.selectThread(thread);
                  setStarMapFloatOpen(true);
                }}
                onFocusLocalInstance={closeStarMap}
                onRefreshLocalThreads={() => {
                  void navigation.refresh?.();
                }}
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
              onOpenMessagingSettings={openMessagingSettings}
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
        <MessagingErrorNotices
          desktopApi={desktopApi}
          onNoticeChanged={syncMessagingErrorNotice}
        />
        <AppNoticeStack
          desktopApi={desktopApi}
          durableNotices={appNotices.durable}
          onDismissDurable={dismissAppNotice}
          onOpenThread={showThreadFromLink}
          transientNotices={[
            {
              notice: navigation.archiveThreadNotice,
              onDismiss: navigation.dismissArchiveThreadNotice,
            },
            ...appNotices.transient.map((notice) => ({
              notice,
              onDismiss: () => dismissAppNotice(notice.id),
            })),
          ]}
        >
          <AppUpdateBanner desktopApi={desktopApi} />
        </AppNoticeStack>
      </div>
    </TranscriptLinkProvider>
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
