import type {
  DesktopChatReplyComposer,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { DesktopSettingsState } from "./useDesktopSettings";
import { AboutSettings } from "./AboutSettings";
import { ExperimentalSettings } from "./ExperimentalSettings";
import { MessagingSettings } from "./MessagingSettings";
import { ModelsSettings } from "./ModelsSettings";
import { ApplicationsSettings } from "./ApplicationsSettings";
import { MessagingActivityScreen } from "../messaging-activity/MessagingActivityScreen";
import { WorktreesSettings } from "./WorktreesSettings";
import { useEffect, useState } from "react";

export type SettingsSection =
  | "experimental"
  | "messaging"
  | "messaging-activity"
  | "models"
  | "applications"
  | "worktrees"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "applications", label: "Applications" },
  { id: "worktrees", label: "Worktrees" },
  { id: "messaging", label: "Messaging" },
  { id: "messaging-activity", label: "Messaging activity" },
  { id: "models", label: "Models" },
  { id: "experimental", label: "Experimental" },
  { id: "about", label: "About" },
];

export function SettingsScreen(props: {
  desktopApi?: DesktopApi;
  settings: DesktopSettingsState;
  /** Initial section to render. Defaults to Applications. */
  initialSection?: SettingsSection;
  onClose?: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(
    props.initialSection ?? "applications",
  );
  // When the parent re-mounts with a different initialSection (e.g.
  // user clicked a platform icon → "messaging-activity"), follow it.
  useEffect(() => {
    if (props.initialSection) setSection(props.initialSection);
  }, [props.initialSection]);
  const snapshot = props.settings.snapshot;

  return (
    <section className="settings-screen" aria-label="Settings">
      <header className="settings-header">
        <div className="settings-header__identity">
          <p className="settings-header__brand">
            Pwr<span className="sidebar__brand-accent">Agent</span>
          </p>
          {props.onClose ? (
            <button
              className="settings-header__exit"
              type="button"
              onClick={props.onClose}
            >
              <span aria-hidden="true">←</span> Exit Settings
            </button>
          ) : null}
        </div>
        <div className="settings-header__title">
          <p className="eyebrow">Settings</p>
          <h1>Settings</h1>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
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
              desktopApi={props.desktopApi}
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
  desktopApi?: DesktopApi;
  section: SettingsSection;
  settings: DesktopSettingsState;
  snapshot: DesktopSettingsSnapshot;
}) {
  if (props.section === "about") {
    return <AboutSettings desktopApi={props.desktopApi} />;
  }

  if (props.section === "experimental") {
    return (
      <ExperimentalSettings
        saving={props.settings.saving}
        snapshot={props.snapshot}
        onComposerChange={async (chatReplyComposer: DesktopChatReplyComposer) => {
          await props.settings.writeConfig({
            experimental: { chatReplyComposer },
          });
        }}
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
        saving={props.settings.saving}
        snapshot={props.snapshot}
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
        onSaveDiscord={async (discord) => {
          await props.settings.writeConfig({
            messaging: {
              discord: {
                applicationId: discord.applicationId.value,
                authorizedGuilds: discord.authorizedGuilds.value,
                authorizedUserIds: discord.authorizedUserIds.value,
                enabled: discord.enabled.value,
                streamingResponses: discord.streamingResponses.value,
              },
            },
          });
        }}
        onSaveTelegram={async (telegram) => {
          await props.settings.writeConfig({
            messaging: {
              telegram: {
                authorizedSupergroups: telegram.authorizedSupergroups.value,
                authorizedUserIds: telegram.authorizedUserIds.value,
                enabled: telegram.enabled.value,
                streamingResponses: telegram.streamingResponses.value,
              },
            },
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

  if (props.section === "messaging-activity") {
    return <MessagingActivityScreen desktopApi={props.desktopApi} />;
  }

  return (
    <ModelsSettings
      saving={props.settings.saving}
      snapshot={props.snapshot}
      onClearSecret={props.settings.clearSecret}
      onReplaceSecret={props.settings.replaceSecret}
      onSaveCodexPath={async (path) => {
        await props.settings.writeConfig({
          models: {
            codex: { path },
          },
        });
      }}
    />
  );
}
