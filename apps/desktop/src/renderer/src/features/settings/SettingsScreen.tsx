import type {
  DesktopSettingsSnapshot,
  DesktopMessagingImageProfile,
  DesktopUpdateChannel,
  MessagingChannelKind,
} from "@pwragent/shared";
import type { AppearanceController } from "../../lib/useAppearance";
import type { DesktopApi } from "../../lib/desktop-api";
import type { PwrAgentProfilesState } from "../../lib/usePwrAgentProfiles";
import type { DesktopSettingsState } from "./useDesktopSettings";
import { AboutSettings } from "./AboutSettings";
import { ExperimentalSettings } from "./ExperimentalSettings";
import { GeneralSettings } from "./GeneralSettings";
import { MessagingSettings } from "./MessagingSettings";
import { ModelsSettings } from "./ModelsSettings";
import { ProfilesSettings } from "./ProfilesSettings";
import { ApplicationsSettings } from "./ApplicationsSettings";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { WorktreesSettings } from "./WorktreesSettings";
import {
  buildDiscordPatchDelta,
  buildFeishuPatchDelta,
  buildLinePatchDelta,
  buildMattermostPatchDelta,
  buildSlackPatchDelta,
  buildTelegramPatchDelta,
} from "./settings-patch-delta";
import { useCallback, useEffect, useState } from "react";

export type SettingsSection =
  | "general"
  | "experimental"
  | "messaging"
  | "models"
  | "profiles"
  | "applications"
  | "worktrees"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "applications", label: "Applications" },
  { id: "profiles", label: "Profiles" },
  { id: "worktrees", label: "Worktrees" },
  { id: "messaging", label: "Messaging" },
  { id: "models", label: "Models" },
  { id: "experimental", label: "Experimental" },
  { id: "about", label: "About" },
];

export function SettingsScreen(props: {
  /** Live theme + density controller from the App root. Threaded down to
   *  Settings → General → Appearance. Optional so the fatal-settings
   *  early-return fallbacks (which render SettingsScreen alone) can omit
   *  it without compile errors — the Appearance UI is hidden there
   *  anyway because the snapshot is unavailable. */
  appearanceController?: AppearanceController;
  desktopApi?: DesktopApi;
  profiles?: PwrAgentProfilesState;
  settings: DesktopSettingsState;
  /** Initial section to render. Defaults to Applications. */
  initialSection?: SettingsSection;
  onClose?: () => void;
  /** Fired when a platform chip in the title-bar strip is clicked.
   *  The App-level handler closes the Settings overlay and opens the
   *  Messaging Activity overlay (its own top-level mainView). */
  onOpenMessagingActivity?: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(
    props.initialSection ?? "general",
  );
  // When the parent re-mounts with a different initialSection (e.g.
  // a future deep-link), follow it.
  useEffect(() => {
    if (props.initialSection) setSection(props.initialSection);
  }, [props.initialSection]);
  const snapshot = props.settings.snapshot;
  const activeSectionLabel =
    SECTIONS.find((entry) => entry.id === section)?.label ?? "Settings";
  // Platform-chip clicks in the title-bar strip route to the top-level
  // Messaging Activity overlay (NOT a settings section). The App-level
  // handler swaps mainView for us; no internal state change here.
  const onOpenMessagingActivity = props.onOpenMessagingActivity;
  const onOpenActivity = useCallback(
    (_platform?: MessagingChannelKind) => {
      onOpenMessagingActivity?.();
    },
    [onOpenMessagingActivity],
  );

  return (
    <section className="settings-screen" aria-label="Settings">
      {/* Left nav — extends full overlay height, mirrors the main
          screen's `.sidebar` pattern. Brand sits in `__masthead`
          at the very top with the 80px stoplight gutter (macOS
          hiddenInset draws stoplights over it). Below: Exit
          Settings, GENERAL group label, section list.
          See plan: docs/plans/2026-05-05-004-feat-settings-overlay-titlebar-plan.md */}
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

        {SECTIONS.map((item) => (
          <button
            key={item.id}
            aria-current={section === item.id ? "page" : undefined}
            className={`settings-nav__button${section === item.id ? " is-active" : ""}`}
            type="button"
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
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
            <span
              className="settings-titlebar__current"
              title={activeSectionLabel}
            >
              {activeSectionLabel}
            </span>
          </div>
          <div className="settings-titlebar__spacer" />
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={onOpenActivity}
          />
        </header>

        <div className="settings-content">
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
              desktopApi={props.desktopApi}
              profiles={props.profiles}
              section={section}
              settings={props.settings}
              snapshot={snapshot}
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
  desktopApi?: DesktopApi;
  profiles?: PwrAgentProfilesState;
  section: SettingsSection;
  settings: DesktopSettingsState;
  snapshot: DesktopSettingsSnapshot;
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
        onDeveloperModeChange={async (developerMode: boolean) => {
          await props.settings.writeConfig({
            general: { developerMode },
          });
        }}
        onUpdateChannelChange={async (channel: DesktopUpdateChannel) => {
          await props.settings.writeConfig({
            updates: { channel },
          });
        }}
        onPastedImageMaxPatchesChange={async (pastedImageMaxPatches) => {
          await props.settings.writeConfig({
            imageUploads: {
              pastedImageMaxPatches,
            },
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
        onDiffCondensationModelChange={async (model: string) => {
          await props.settings.writeConfig({
            experimental: { diffCondensation: { model } },
          });
        }}
      />
    );
  }

  if (props.section === "messaging") {
    return (
      <MessagingSettings
        desktopApi={props.desktopApi}
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
      desktopApi={props.desktopApi}
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
    />
  );
}
