import type {
  AppServerBackendKind,
  BackendSummary,
  DesktopHotCpuProfileStartDelayMs,
  DesktopHotCpuProfileTriggerMode,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  DesktopMessagingImageProfile,
  DesktopUpdateChannel,
  DesktopUpdateTrain,
  MessagingChannelKind,
} from "@pwragent/shared";
import type { AppearanceController } from "../../lib/useAppearance";
import type { DesktopApi } from "../../lib/desktop-api";
import type { PwrAgentProfilesState } from "../../lib/usePwrAgentProfiles";
import type { DesktopSettingsState } from "./useDesktopSettings";
import { AboutSettings } from "./AboutSettings";
import { AccessControlSettings } from "./AccessControlSettings";
import { ExperimentalSettings } from "./ExperimentalSettings";
import { FederationSettings } from "./FederationSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitSettings } from "./GitSettings";
import {
  MESSAGING_SETTINGS_PLATFORMS,
  MessagingSettings,
  type MessagingSettingsFocus,
} from "./MessagingSettings";
import { formatMessagingPlatformName } from "../../lib/messaging-platform-branding";
import { ModelsSettings } from "./ModelsSettings";
import { ProfilesSettings } from "./ProfilesSettings";
import { PricingSettings } from "./PricingSettings";
import { ApplicationsSettings } from "./ApplicationsSettings";
import { PluginsSettings } from "./PluginsSettings";
import { ArchivedThreadsSettings } from "./ArchivedThreadsSettings";
import { ThreadManagementSettings } from "./ThreadManagementSettings";
import { TroubleshootingSettings } from "./TroubleshootingSettings";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { WorktreesSettings } from "./WorktreesSettings";
import {
  buildDiscordPatchDelta,
  buildFeishuPatchDelta,
  buildLinePatchDelta,
  buildMattermostPatchDelta,
  buildSlackPatchDelta,
  buildTelegramPatchDelta,
} from "./settings-patch-delta";
import {
  acpAgentEnabledInSnapshot,
  displayOrderedAcpEntries,
  useAcpAgentCatalog,
} from "./useAcpAgentCatalog";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type SettingsSection =
  | "general"
  | "git"
  | "experimental"
  | "messaging"
  | "federation"
  | "access-control"
  | "models"
  | "profiles"
  | "pricing"
  | "applications"
  | "plugins"
  | "worktrees"
  | "thread-management"
  | "archived"
  | "troubleshooting"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "applications", label: "Applications" },
  { id: "plugins", label: "Plugins" },
  { id: "profiles", label: "Profiles" },
  { id: "models", label: "AI Providers" },
  { id: "pricing", label: "Usage & Pricing" },
  { id: "messaging", label: "Messaging" },
  { id: "access-control", label: "Access Control" },
  { id: "git", label: "Git" },
  { id: "federation", label: "Federation" },
  { id: "worktrees", label: "Worktrees" },
  { id: "thread-management", label: "Thread Management" },
  { id: "archived", label: "Archived Threads" },
  { id: "experimental", label: "Experimental" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "about", label: "About" },
];

const PRIMARY_SECTIONS: SettingsSection[] = [
  "general",
  "applications",
  "plugins",
  "profiles",
  "models",
  "pricing",
  "messaging",
  "federation",
];

const SETTINGS_NAV_DIVIDER_AFTER: SettingsSection = "federation";

/** Sections whose nav row expands into a sub-list (thread-list caret). */
const SETTINGS_NAV_GROUPS = new Set<SettingsSection>([
  "plugins",
  "models",
  "messaging",
]);

function messagingPlatformFromSub(
  sub: string | undefined,
): MessagingSettingsFocus | undefined {
  return MESSAGING_SETTINGS_PLATFORMS.find((platform) => platform === sub);
}

type SettingsNavChild = {
  key: string;
  label: string;
  /** Sub-route id; undefined = the child re-targets the parent section
   *  (Plugins → MCPs, which IS the plugins pane). */
  sub?: string;
  /** Status dot tone; omitted when the snapshot can't say. */
  dot?: "ok" | "off";
  /** Tiny trailing chip, e.g. "off" on a disabled provider. */
  chip?: string;
};

const SECTION_LABELS = new Map(
  SECTIONS.map((section) => [section.id, section.label] as const),
);

const ORDERED_SECTION_IDS: SettingsSection[] = [
  ...PRIMARY_SECTIONS,
  "access-control",
  "git",
  "worktrees",
  "thread-management",
  "archived",
  "experimental",
  "troubleshooting",
  "about",
];

const ORDERED_SECTIONS = ORDERED_SECTION_IDS.map((id) => ({
  id,
  label: SECTION_LABELS.get(id) ?? id,
}));

export function SettingsScreen(props: {
  /** Live theme + density controller from the App root. Threaded down to
   *  Settings → General → Appearance. Optional so the fatal-settings
   *  early-return fallbacks (which render SettingsScreen alone) can omit
   *  it without compile errors — the Appearance UI is hidden there
   *  anyway because the snapshot is unavailable. */
  appearanceController?: AppearanceController;
  cachedBackends?: BackendSummary[];
  desktopApi?: DesktopApi;
  profiles?: PwrAgentProfilesState;
  settings: DesktopSettingsState;
  /** Initial section to render. Defaults to Applications. */
  initialSection?: SettingsSection;
  /** Optional sub-screen within the initial section (a provider's
   *  registry id under "models", a platform kind under "messaging").
   *  Ignored without `initialSection`. */
  initialSubsection?: string;
  onClose?: () => void;
  onOpenThread?: (target: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => void;
  onShowNotice?: (notice: AppNoticeToastNotice) => void;
  /** Fired from the title-bar messaging controller.
   *  The App-level handler closes the Settings overlay and opens the
   *  Messaging Activity overlay (its own top-level mainView). */
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
}) {
  const [route, setRoute] = useState<{
    section: SettingsSection;
    sub?: string;
  }>(() => ({
    section: props.initialSection ?? "general",
    sub: props.initialSection ? props.initialSubsection : undefined,
  }));
  const section = route.section;
  // Which nav groups are expanded. Groups open collapsed except the
  // one holding the initial route — an active section hidden behind a
  // closed caret would read as a dead nav.
  const [openGroups, setOpenGroups] = useState<
    Partial<Record<SettingsSection, boolean>>
  >(() => {
    const initial = props.initialSection ?? "general";
    return SETTINGS_NAV_GROUPS.has(initial) ? { [initial]: true } : {};
  });
  const expandGroup = useCallback((target: SettingsSection) => {
    if (!SETTINGS_NAV_GROUPS.has(target)) {
      return;
    }
    setOpenGroups((current) =>
      current[target] === true ? current : { ...current, [target]: true },
    );
  }, []);
  const toggleGroup = useCallback((target: SettingsSection) => {
    setOpenGroups((current) => ({
      ...current,
      [target]: current[target] !== true,
    }));
  }, []);
  // Navigating always expands the destination group; only the caret
  // collapses one. Clicking a parent label therefore both routes to
  // the hub screen and reveals its children.
  const openRoute = useCallback(
    (target: SettingsSection, sub?: string) => {
      setRoute((current) =>
        current.section === target && current.sub === sub
          ? current
          : { section: target, sub },
      );
      expandGroup(target);
    },
    [expandGroup],
  );
  // When the parent re-mounts with a different initialSection (e.g.
  // a future deep-link), follow it.
  useEffect(() => {
    if (props.initialSection) {
      openRoute(props.initialSection, props.initialSubsection);
    }
  }, [openRoute, props.initialSection, props.initialSubsection]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Reset the pane scroll on every route change. Runs in a layout
  // effect so the stack's own visited-section focus restore (a plain
  // effect) can still win afterwards by scrolling its header into view.
  useLayoutEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [route.section, route.sub]);
  const scrollClampFrameRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const clampDocumentScroll = () => {
      if (window.scrollX === 0 && window.scrollY === 0) {
        return;
      }
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      window.scrollTo(0, 0);
      void props.desktopApi?.logRendererDiagnostic?.({
        level: "warn",
        message: "Settings document scroll clamped.",
        details: {
          section,
          scrollX,
          scrollY,
        },
      })?.catch(() => undefined);
    };
    const scheduleClamp = () => {
      if (scrollClampFrameRef.current !== undefined) {
        return;
      }
      scrollClampFrameRef.current = window.requestAnimationFrame(() => {
        scrollClampFrameRef.current = undefined;
        clampDocumentScroll();
      });
    };
    clampDocumentScroll();
    window.addEventListener("scroll", scheduleClamp, { passive: true });
    return () => {
      window.removeEventListener("scroll", scheduleClamp);
      if (scrollClampFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollClampFrameRef.current);
        scrollClampFrameRef.current = undefined;
      }
    };
  }, [props.desktopApi, section]);
  const snapshot = props.settings.snapshot;
  const activeSectionLabel =
    SECTIONS.find((entry) => entry.id === section)?.label ?? "Settings";
  // Cached catalog read only — the nav never triggers agent probes.
  // The AI Providers screens own refreshing; this re-reads on their
  // BACKEND_SUMMARIES_REFRESH_EVENT announcements.
  const acpCatalog = useAcpAgentCatalog(props.desktopApi);
  const navChildren = (target: SettingsSection): SettingsNavChild[] => {
    if (target === "plugins") {
      return [{ key: "mcps", label: "MCPs" }];
    }
    if (target === "models") {
      const codexConfigured = Boolean(
        snapshot?.models.codex.discovery.selectedCommand,
      );
      return [
        {
          key: "codex",
          label: "Codex",
          sub: "codex",
          dot: snapshot ? (codexConfigured ? "ok" : "off") : undefined,
        },
        ...displayOrderedAcpEntries(acpCatalog.entries).map((entry) => {
          const enabled = acpAgentEnabledInSnapshot(snapshot, entry.registryId);
          return {
            key: entry.registryId,
            label: entry.name,
            sub: entry.registryId,
            dot: (enabled && entry.installed ? "ok" : "off") as "ok" | "off",
            ...(enabled ? {} : { chip: "off" }),
          };
        }),
      ];
    }
    if (target === "messaging") {
      return MESSAGING_SETTINGS_PLATFORMS.map((platform) => ({
        key: platform,
        label: formatMessagingPlatformName(platform),
        sub: platform,
        dot: snapshot
          ? snapshot.messaging[platform].enabled.value
            ? "ok"
            : "off"
          : undefined,
      }));
    }
    return [];
  };
  // Crumb label from the same catalog the nav renders. An unknown sub
  // gets no crumb rather than leaking the raw route id into the
  // breadcrumb.
  const activeSubLabel = route.sub
    ? navChildren(section).find((child) => child.sub === route.sub)?.label
    : undefined;
  // Platform-chip clicks in the title-bar strip route to the top-level
  // Messaging Activity overlay (NOT a settings section). The App-level
  // handler swaps mainView for us; no internal state change here.
  const onOpenMessagingActivity = props.onOpenMessagingActivity;
  const onOpenActivity = useCallback(
    (platform?: MessagingChannelKind) => {
      onOpenMessagingActivity?.(platform);
    },
    [onOpenMessagingActivity],
  );

  return (
    <section className="settings-screen" aria-label="Settings">
      {/* Left nav — extends full overlay height, mirrors the main
          screen's `.sidebar` pattern. Brand sits in `__masthead`
          at the very top with the 80px stoplight gutter (macOS
          hiddenInset draws stoplights over it). Below: Exit
          Settings, GENERAL group label, section list. */}
      <nav className="settings-nav" aria-label="Settings sections">
        <header className="settings-nav__masthead">
          <p className="settings-nav__brand">
            Pwr<span className="settings-nav__brand-accent">Agent</span>
          </p>
        </header>

        {/* Exit Settings — first interactive row of the nav. Plain
            text-style link (no border) per the design. */}
        {props.onClose ? (
          <button
            className="settings-nav__exit"
            type="button"
            onClick={props.onClose}
          >
            <span aria-hidden="true">←</span> Exit Settings
          </button>
        ) : null}

        {/* Group label between Exit and the section list. */}
        <p className="settings-nav__group-label">General</p>

        {/* Section list is its own scroll container so the masthead and
            Exit stay pinned. The nav itself is `overflow: hidden`; with
            the rows as direct children the list clipped instead of
            scrolling, and at the 640px minimum window height its tail
            was unreachable by pointer. See `.settings-nav__sections`. */}
        <div className="settings-nav__sections">
          {ORDERED_SECTIONS.map((item) => {
            const isGroup = SETTINGS_NAV_GROUPS.has(item.id);
            const open = openGroups[item.id] === true;
            const sublistId = `settings-nav-sublist-${item.id}`;
            // Plugins keeps its long-standing contract: the MCPs child —
            // the pane's whole content — carries the active state, not
            // the parent row.
            const groupHoldsRoute = section === item.id;
            const parentActive =
              groupHoldsRoute
              && route.sub === undefined
              && item.id !== "plugins";
            // A collapsed group hides its aria-current child inside an
            // aria-hidden, inert sublist, so the parent row takes over
            // the marker — the nav must always show where the operator
            // is (this also covers collapsed Plugins).
            const parentMarksRoute =
              parentActive || (isGroup && !open && groupHoldsRoute);
            const children = isGroup ? navChildren(item.id) : [];
            return (
              <Fragment key={item.id}>
                <div
                  className={`settings-nav__row${parentMarksRoute ? " is-active" : ""}`}
                >
                  {isGroup ? (
                    <button
                      aria-controls={sublistId}
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
                      className="settings-nav__caret"
                      type="button"
                      onClick={() => toggleGroup(item.id)}
                    >
                      <span
                        aria-hidden="true"
                        className={`settings-nav__caret-mark${open ? " is-open" : ""}`}
                      />
                    </button>
                  ) : (
                    <span
                      aria-hidden="true"
                      className="settings-nav__caret-spacer"
                    />
                  )}
                  <button
                    aria-current={parentMarksRoute ? "page" : undefined}
                    className={`settings-nav__button${parentMarksRoute ? " is-active" : ""}`}
                    type="button"
                    onClick={() => openRoute(item.id)}
                  >
                    {item.label}
                  </button>
                </div>
                {isGroup ? (
                  <div
                    aria-hidden={!open}
                    className={`settings-nav__sublist${open ? " is-open" : ""}`}
                    id={sublistId}
                    inert={open ? undefined : true}
                  >
                    <div className="settings-nav__sublist-clip">
                      {children.map((child) => {
                        const childActive =
                          section === item.id && route.sub === child.sub;
                        return (
                          <button
                            key={child.key}
                            aria-current={childActive ? "page" : undefined}
                            className={`settings-nav__subbutton${
                              childActive ? " is-active" : ""
                            }`}
                            type="button"
                            onClick={() => openRoute(item.id, child.sub)}
                          >
                            {child.dot ? (
                              <span
                                aria-hidden="true"
                                className={`settings-nav__subdot settings-nav__subdot--${child.dot}`}
                              />
                            ) : null}
                            <span className="settings-nav__sublabel">
                              {child.label}
                            </span>
                            {child.chip ? (
                              <span className="settings-nav__subchip">
                                {child.chip}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {item.id === SETTINGS_NAV_DIVIDER_AFTER ? (
                  <hr className="settings-nav__divider" />
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </nav>

      {/* Right pane — its own header (breadcrumb + MessagingStatusBar)
          above the content. The header sits ONLY above the content
          area, not full-width across the window — same vertical-split
          pattern the main screen uses (Sidebar | ThreadView with
          ThreadHeader). */}
      <div className="settings-main">
        <header className="settings-titlebar">
          <div className="settings-titlebar__breadcrumb">
            <span className="settings-titlebar__eyebrow">Settings</span>
            <span aria-hidden="true" className="settings-titlebar__separator">
              ›
            </span>
            {route.sub && activeSubLabel ? (
              <>
                <button
                  className="settings-titlebar__crumb"
                  type="button"
                  onClick={() => openRoute(section)}
                >
                  {activeSectionLabel}
                </button>
                <span
                  aria-hidden="true"
                  className="settings-titlebar__separator"
                >
                  ›
                </span>
                <span
                  className="settings-titlebar__current"
                  title={activeSubLabel}
                >
                  {activeSubLabel}
                </span>
              </>
            ) : (
              <span
                className="settings-titlebar__current"
                title={activeSectionLabel}
              >
                {activeSectionLabel}
              </span>
            )}
          </div>
          <div className="settings-titlebar__spacer" />
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={onOpenActivity}
            onOpenSettings={() => openRoute("messaging")}
          />
        </header>

        <div className="settings-content" ref={contentRef}>
          {props.settings.loading && !snapshot ? (
            <p className="settings-empty">Loading settings...</p>
          ) : props.settings.error && !snapshot ? (
            <div className="settings-panel">
              <p className="settings-row__error">{props.settings.error}</p>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  void props.settings.refresh();
                }}
              >
                Retry
              </button>
            </div>
          ) : snapshot?.configError ? (
            <div className="settings-panel settings-panel--error" role="alert">
              <div className="settings-panel__header">
                <div>
                  <p className="eyebrow">Config Error</p>
                  <h2>Settings config did not load</h2>
                </div>
              </div>
              <div className="settings-error-block">
                <p>{snapshot.configError}</p>
                <code>{snapshot.configPath}</code>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => {
                    void props.settings.refresh();
                  }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : snapshot ? (
            <SettingsSectionBody
              appearanceController={props.appearanceController}
              cachedBackends={props.cachedBackends}
              desktopApi={props.desktopApi}
              onOpenRoute={openRoute}
              onOpenThread={props.onOpenThread}
              onShowNotice={props.onShowNotice}
              profiles={props.profiles}
              section={section}
              settings={props.settings}
              snapshot={snapshot}
              sub={route.sub}
            />
          ) : (
            <p className="settings-empty">Settings are unavailable.</p>
          )}
          {props.settings.error && snapshot ? (
            <p className="settings-row__error">{props.settings.error}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SettingsSectionBody(props: {
  appearanceController?: AppearanceController;
  cachedBackends?: BackendSummary[];
  desktopApi?: DesktopApi;
  onOpenRoute: (section: SettingsSection, sub?: string) => void;
  onOpenThread?: (target: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => void;
  onShowNotice?: (notice: AppNoticeToastNotice) => void;
  profiles?: PwrAgentProfilesState;
  section: SettingsSection;
  settings: DesktopSettingsState;
  snapshot: DesktopSettingsSnapshot;
  sub?: string;
}) {
  if (props.section === "about") {
    return <AboutSettings desktopApi={props.desktopApi} />;
  }

  if (props.section === "general") {
    return (
      <GeneralSettings
        appearanceController={props.appearanceController}
        desktopApi={props.desktopApi}
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onConfirmQuitWithInProgressThreadsChange={async (
          confirmQuitWithInProgressThreads: boolean,
        ) => {
          await props.settings.writeConfig({
            general: { confirmQuitWithInProgressThreads },
          });
        }}
        onAttentionPromoteOnTurnEndChange={async (
          attentionPromoteOnTurnEnd: boolean,
        ) => {
          await props.settings.writeConfig({
            general: { attentionPromoteOnTurnEnd },
          });
        }}
        onPdfAnalysisEnabledChange={async (pdfAnalysisEnabled) => {
          await props.settings.writeConfig({
            general: { pdfAnalysisEnabled },
          });
        }}
        onUpdateChannelChange={async (channel: DesktopUpdateChannel) => {
          await props.settings.writeConfig({
            updates: {
              channel,
              train: props.snapshot.updates.train.value,
            },
          });
        }}
        onUpdateTrainChange={async (train: DesktopUpdateTrain) => {
          await props.settings.writeConfig({
            updates: {
              train,
              channel: props.snapshot.updates.channel.value,
            },
          });
        }}
        onPastedImageMaxPatchesChange={async (pastedImageMaxPatches) => {
          await props.settings.writeConfig({
            imageUploads: {
              pastedImageMaxPatches,
            },
          });
        }}
        onNotificationsEnabledChange={async (notificationsEnabled) => {
          await props.settings.writeConfig({
            general: { notificationsEnabled },
          });
        }}
        onClearMessagingAcknowledgment={async () => {
          await props.settings.writeConfig({
            general: { messagingAcknowledgment: null },
          });
        }}
      />
    );
  }

  if (props.section === "troubleshooting") {
    return (
      <TroubleshootingSettings
        desktopApi={props.desktopApi}
        onShowNotice={props.onShowNotice}
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onDeveloperModeChange={async (developerMode: boolean) => {
          await props.settings.writeConfig({
            general: { developerMode },
          });
        }}
        onHotCpuProfilingEnabledChange={async (
          hotCpuProfilingEnabled: boolean,
        ) => {
          await props.settings.writeConfig({
            general: { hotCpuProfilingEnabled },
          });
        }}
        onHotCpuProfilingStartDelayMsChange={async (
          hotCpuProfilingStartDelayMs: DesktopHotCpuProfileStartDelayMs,
        ) => {
          await props.settings.writeConfig({
            general: { hotCpuProfilingStartDelayMs },
          });
        }}
        onHotCpuProfilingTriggerModeChange={async (
          hotCpuProfilingTriggerMode: DesktopHotCpuProfileTriggerMode,
        ) => {
          await props.settings.writeConfig({
            general: { hotCpuProfilingTriggerMode },
          });
        }}
        onHotCpuProfilingCaptureHeapSnapshotChange={async (
          hotCpuProfilingCaptureHeapSnapshot: boolean,
        ) => {
          await props.settings.writeConfig({
            general: {
              hotCpuProfilingCaptureHeapSnapshot,
            },
          });
        }}
        onHotCpuProfilingHeapSnapshotLimitChange={async (
          hotCpuProfilingHeapSnapshotLimit: number,
        ) => {
          await props.settings.writeConfig({
            general: { hotCpuProfilingHeapSnapshotLimit },
          });
        }}
      />
    );
  }

  if (props.section === "pricing") {
    return (
      <PricingSettings
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onThreadPricingSummaryChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { threadPricingSummary: enabled },
          });
        }}
        onThreadPricingDisplayUsdChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { threadPricingDisplayUsd: enabled },
          });
        }}
        onThreadPricingDisplayCodexCreditsChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { threadPricingDisplayCodexCredits: enabled },
          });
        }}
        onToolOutputAlertsChange={async (toolOutputAlerts) => {
          await props.settings.writeConfig({
            general: { toolOutputAlerts },
          });
        }}
        onSpendAlertsChange={async (spendAlerts) => {
          await props.settings.writeConfig({
            general: { spendAlerts },
          });
        }}
      />
    );
  }

  if (props.section === "experimental") {
    return (
      <ExperimentalSettings
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onDiffCondensationEnabledChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { diffCondensation: { enabled } },
          });
        }}
        onLiveTranscriptEventFilteringChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { liveTranscriptEventFiltering: enabled },
          });
        }}
        onLightweightNavigationRefreshChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { lightweightNavigationRefresh: enabled },
          });
        }}
        onMarkdownMathRenderingChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { markdownMathRendering: enabled },
          });
        }}
        onThreadToolAccountingChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { threadToolAccounting: enabled },
          });
        }}
        onTokenMiserEnabledChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { tokenMiserEnabled: enabled },
          });
        }}
        onTokenMiserDefaultEnabledChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { tokenMiserDefaultEnabled: enabled },
          });
        }}
        onCodexDefaultModeRequestUserInputChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { codexDefaultModeRequestUserInput: enabled },
          });
        }}
        onManagedReviewChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            experimental: { managedReview: enabled },
          });
        }}
      />
    );
  }

  if (props.section === "messaging") {
    return (
      <MessagingSettings
        desktopApi={props.desktopApi}
        focus={messagingPlatformFromSub(props.sub)}
        onFocusChange={(focus) => props.onOpenRoute("messaging", focus)}
        onOpenThread={props.onOpenThread}
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onPairingSettingsChanged={props.settings.refresh}
        onClearSecret={props.settings.clearSecret}
        onReplaceSecret={props.settings.replaceSecret}
        onToolUpdateModeChange={async (toolUpdateMode) => {
          await props.settings.writeConfig({
            messaging: {
              toolUpdateMode,
            },
          });
        }}
        onManagerToolUpdateModeChange={async (managerToolUpdateMode) => {
          await props.settings.writeConfig({
            messaging: {
              managerToolUpdateMode,
            },
          });
        }}
        onShowStreamingOptionChange={async (showStreamingOption) => {
          await props.settings.writeConfig({
            messaging: {
              showStreamingOption,
            },
          });
        }}
        onInputDebounceMsChange={async (inputDebounceMs) => {
          await props.settings.writeConfig({
            messaging: {
              inputDebounceMs,
            },
          });
        }}
        onImageProfileChange={async (
          imageProfile: DesktopMessagingImageProfile,
        ) => {
          await props.settings.writeConfig({
            messaging: {
              attachments: { imageProfile },
            },
          });
        }}
        onPdfProfileChange={async (
          pdfProfile: DesktopMessagingImageProfile,
        ) => {
          await props.settings.writeConfig({
            messaging: {
              attachments: { pdfProfile },
            },
          });
        }}
        onMessagingEnabledChange={async (enabled) => {
          if (props.snapshot.runtime.messaging.overrideActive) {
            await props.desktopApi?.setMessagingEnabled?.({ enabled });
            await props.settings.refresh();
            return;
          }
          await props.settings.writeConfig({
            messaging: {
              enabled,
            },
          });
        }}
        onFullAccessThreadResumeChange={async (allowFullAccessThreadResume) => {
          await props.settings.writeConfig({
            messaging: {
              allowFullAccessThreadResume,
            },
          });
        }}
        onFullAccessEscalationChange={async (allowFullAccessEscalation) => {
          await props.settings.writeConfig({
            messaging: {
              allowFullAccessEscalation,
            },
          });
        }}
        onFullAccessWarningPolicyChange={async (fullAccessWarning) => {
          await props.settings.writeConfig({
            messaging: {
              fullAccessWarning,
            },
          });
        }}
        onSaveDiscord={async (discord) => {
          const delta = buildDiscordPatchDelta(
            props.snapshot.messaging.discord,
            discord,
          );
          if (delta === undefined) return;
          await props.settings.writeConfig({
            messaging: { discord: delta },
          });
        }}
        onSaveTelegram={async (telegram) => {
          const delta = buildTelegramPatchDelta(
            props.snapshot.messaging.telegram,
            telegram,
          );
          if (delta === undefined) return;
          await props.settings.writeConfig({
            messaging: { telegram: delta },
          });
        }}
        onSaveMattermost={async (mattermost) => {
          const delta = buildMattermostPatchDelta(
            props.snapshot.messaging.mattermost,
            mattermost,
          );
          if (delta === undefined) return;
          await props.settings.writeConfig({
            messaging: { mattermost: delta },
          });
        }}
        onSaveSlack={async (slack) => {
          const delta = buildSlackPatchDelta(
            props.snapshot.messaging.slack,
            slack,
          );
          if (delta === undefined) return;
          await props.settings.writeConfig({
            messaging: { slack: delta },
          });
        }}
        onSaveFeishu={async (feishu) => {
          const delta = buildFeishuPatchDelta(
            props.snapshot.messaging.feishu,
            feishu,
          );
          if (delta === undefined) return;
          await props.settings.writeConfig({
            messaging: { feishu: delta },
          });
        }}
        onSaveLine={async (line) => {
          const delta = buildLinePatchDelta(
            props.snapshot.messaging.line,
            line,
          );
          if (delta === undefined) return;
          await props.settings.writeConfig({
            messaging: { line: delta },
          });
        }}
      />
    );
  }

  if (props.section === "federation") {
    return (
      <FederationSettings
        desktopApi={props.desktopApi}
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onClearSecret={props.settings.clearSecret}
        onReplaceSecret={props.settings.replaceSecret}
        onSettingsChanged={props.settings.refresh}
        onWriteConfig={props.settings.writeConfig}
      />
    );
  }

  if (props.section === "access-control") {
    return props.desktopApi ? (
      <AccessControlSettings desktopApi={props.desktopApi} />
    ) : null;
  }

  if (props.section === "archived") {
    return <ArchivedThreadsSettings desktopApi={props.desktopApi} />;
  }

  if (props.section === "thread-management") {
    return <ThreadManagementSettings desktopApi={props.desktopApi} />;
  }

  if (props.section === "applications") {
    return (
      <ApplicationsSettings
        desktopApi={props.desktopApi}
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onPreferredApplicationChange={async (kind, preferredId) => {
          await props.settings.writeConfig({
            applications:
              kind === "editor"
                ? { editor: { preferredId } }
                : { terminal: { preferredId } },
          });
        }}
        onRefresh={props.settings.refresh}
        onSaveGhPath={async (path) => {
          await props.settings.writeConfig({
            applications: {
              gh: { path },
            },
          });
        }}
        onSaveGitPath={async (path) => {
          await props.settings.writeConfig({
            applications: {
              git: { path },
            },
          });
        }}
      />
    );
  }

  if (props.section === "plugins") {
    return (
      <PluginsSettings
        desktopApi={props.desktopApi}
        snapshot={props.snapshot}
      />
    );
  }

  if (props.section === "git") {
    return (
      <GitSettings
        desktopApi={props.desktopApi}
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onBackgroundPrPollingChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            git: { backgroundPrPolling: enabled },
          });
        }}
        onPrAutoDispatchAllowedChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            git: { prAutoDispatchAllowed: enabled },
          });
        }}
        onDefaultPrAutoDispatchEnabledChange={async (enabled: boolean) => {
          await props.settings.writeConfig({
            git: { defaultPrAutoDispatchEnabled: enabled },
          });
        }}
        onPrAutoDispatchBudgetCapacityChange={async (capacity: number) => {
          await props.settings.writeConfig({
            git: { prAutoDispatchBudgetCapacity: capacity },
          });
        }}
        onPrAutoDispatchBudgetRefillPerMinuteChange={async (
          refillPerMinute: number,
        ) => {
          await props.settings.writeConfig({
            git: { prAutoDispatchBudgetRefillPerMinute: refillPerMinute },
          });
        }}
        onPausePrAutoDispatchWhenBudgetEmptyChange={async (
          enabled: boolean,
        ) => {
          await props.settings.writeConfig({
            git: { pausePrAutoDispatchWhenBudgetEmpty: enabled },
          });
        }}
        onRefresh={props.settings.refresh}
        onSaveGhPath={async (path) => {
          await props.settings.writeConfig({
            applications: {
              gh: { path },
            },
          });
        }}
        onSaveGitPath={async (path) => {
          await props.settings.writeConfig({
            applications: {
              git: { path },
            },
          });
        }}
      />
    );
  }

  if (props.section === "profiles") {
    return (
      <ProfilesSettings
        desktopApi={props.desktopApi}
        profiles={props.profiles}
        snapshot={props.snapshot}
        onSettingsChanged={props.settings.refresh}
      />
    );
  }

  if (props.section === "worktrees") {
    return (
      <WorktreesSettings
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onStorageChange={async (storage) => {
          await props.settings.writeConfig({
            worktrees: { storage },
          });
        }}
      />
    );
  }

  return (
    <ModelsSettings
      cachedBackends={props.cachedBackends}
      desktopApi={props.desktopApi}
      focus={props.sub}
      onFocusChange={(focus) => props.onOpenRoute("models", focus)}
      saving={props.settings.saving}
      snapshot={props.snapshot}
      onClearSecret={props.settings.clearSecret}
      onReplaceSecret={props.settings.replaceSecret}
      onRefresh={props.settings.refresh}
      onSaveCodexPath={async (path) => {
        await props.settings.writeConfig({
          models: {
            codex: { path },
          },
        });
      }}
      onSaveCodexProfile={async (profile) => {
        await props.settings.writeConfig({
          models: {
            codex: { profile },
          },
        });
      }}
      onSaveProviderDefaults={async (providerDefaults) => {
        await props.settings.writeConfig({
          models: { providerDefaults },
        });
      }}
      onSaveProviderThreadMigrations={async (providerThreadMigrations) => {
        return await props.settings.writeConfig({
          models: { providerThreadMigrations },
        });
      }}
      onSaveCodexFastAllowed={async (allowFast) => {
        return await props.settings.writeConfig({
          models: {
            codex: { allowFast },
          },
        });
      }}
      onAcpCliPathChange={async (registryId, cliPath) => {
        return await props.settings.writeConfig({
          acpAgents: { [registryId]: { cliPath } } as NonNullable<
            DesktopSettingsConfigPatch["acpAgents"]
          >,
        });
      }}
      onAcpEnabledChange={async (registryId, enabled) => {
        await props.settings.writeConfig({
          acpAgents: { [registryId]: { enabled } } as NonNullable<
            DesktopSettingsConfigPatch["acpAgents"]
          >,
        });
      }}
      onManagedGrokBuildsChange={async (managedBuilds) => {
        return await props.settings.writeConfig({
          acpAgents: { grok: { managedBuilds } },
        });
      }}
    />
  );
}
