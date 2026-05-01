import type {
  DesktopChatReplyComposer,
  DesktopSettingsSnapshot,
} from "@pwragnt/shared";
import type { DesktopSettingsState } from "./useDesktopSettings";
import { ExperimentalSettings } from "./ExperimentalSettings";
import { MessagingSettings } from "./MessagingSettings";
import { ModelsSettings } from "./ModelsSettings";
import { ApplicationsSettings } from "./ApplicationsSettings";
import { useState } from "react";

type SettingsSection = "experimental" | "messaging" | "models" | "applications";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "applications", label: "Applications" },
  { id: "messaging", label: "Messaging" },
  { id: "models", label: "Models" },
  { id: "experimental", label: "Experimental" },
];

export function SettingsScreen(props: {
  settings: DesktopSettingsState;
  onClose?: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("applications");
  const snapshot = props.settings.snapshot;

  return (
    <section className="settings-screen" aria-label="Settings">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Settings</h1>
        </div>
        {props.onClose ? (
          <button className="button button--secondary" type="button" onClick={props.onClose}>
            Back
          </button>
        ) : null}
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
  section: SettingsSection;
  settings: DesktopSettingsState;
  snapshot: DesktopSettingsSnapshot;
}) {
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
        onSaveDiscord={async (discord) => {
          await props.settings.writeConfig({
            messaging: {
              discord: {
                applicationId: discord.applicationId.value,
                authorizedGuilds: discord.authorizedGuilds.value,
                authorizedUserIds: discord.authorizedUserIds.value,
                enabled: discord.enabled.value,
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
