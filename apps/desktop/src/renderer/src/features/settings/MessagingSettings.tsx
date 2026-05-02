import { useState, type ReactNode } from "react";
import type {
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
  MessagingToolUpdateMode,
} from "@pwragnt/shared";
import {
  formatSourceLabel,
  joinListValue,
  optionalListSourceBadge,
  optionalStringSourceBadge,
  parseListValue,
  sourceBadge,
} from "./settings-fields";

export function MessagingSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  onToolUpdateModeChange: (mode: MessagingToolUpdateMode) => Promise<void>;
  onSaveDiscord: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["discord"]>,
  ) => Promise<void>;
  onSaveTelegram: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["telegram"]>,
  ) => Promise<void>;
}) {
  const telegram = props.snapshot.messaging.telegram;
  const discord = props.snapshot.messaging.discord;
  const toolUpdateMode = props.snapshot.messaging.toolUpdateMode;
  const runtimeMessaging = props.snapshot.runtime.messaging;

  return (
    <section className="settings-stack" aria-label="Messaging settings">
      {runtimeMessaging.disabled ? (
        <section className="settings-panel settings-panel--warning" role="status">
          <div className="settings-panel__header">
            <div>
              <p className="eyebrow">Runtime Override</p>
              <h2>Messaging disabled for this app instance</h2>
            </div>
          </div>
          <p className="settings-row__description">
            {runtimeMessaging.disabledReason
              ?? "Messaging startup was disabled by a launch override."}
          </p>
        </section>
      ) : null}
      <MessagingGroup title="General">
        <SegmentedField
          disabled={props.saving}
          label="Tool usage notifications"
          options={TOOL_UPDATE_MODE_OPTIONS}
          source={sourceBadge(toolUpdateMode)}
          value={toolUpdateMode.value}
          onChange={(mode) => {
            void props.onToolUpdateModeChange(mode);
          }}
        />
      </MessagingGroup>

      <MessagingGroup title="Telegram">
        <ToggleField
          checked={telegram.enabled.value}
          disabled={props.saving}
          label="Enabled"
          source={sourceBadge(telegram.enabled)}
          onChange={(enabled) => {
            void props.onSaveTelegram({
              ...telegram,
              enabled: { ...telegram.enabled, value: enabled },
            });
          }}
        />
        <SecretField
          disabled={props.saving || !telegram.botToken.writable}
          label="Bot Token"
          secret="telegramBotToken"
          state={telegram.botToken}
          onClearSecret={props.onClearSecret}
          onReplaceSecret={props.onReplaceSecret}
        />
        <ListField
          disabled={props.saving}
          label="Authorized User IDs"
          source={optionalListSourceBadge(telegram.authorizedUserIds)}
          value={telegram.authorizedUserIds.value}
          onSave={(authorizedUserIds) => {
            void props.onSaveTelegram({
              ...telegram,
              authorizedUserIds: {
                ...telegram.authorizedUserIds,
                value: authorizedUserIds,
              },
            });
          }}
        />
        <ListField
          disabled={props.saving}
          label="Authorized SuperGroups"
          source={optionalListSourceBadge(telegram.authorizedSupergroups)}
          value={telegram.authorizedSupergroups.value}
          onSave={(authorizedSupergroups) => {
            void props.onSaveTelegram({
              ...telegram,
              authorizedSupergroups: {
                ...telegram.authorizedSupergroups,
                value: authorizedSupergroups,
              },
            });
          }}
        />
      </MessagingGroup>

      <MessagingGroup title="Discord">
        <ToggleField
          checked={discord.enabled.value}
          disabled={props.saving}
          label="Enabled"
          source={sourceBadge(discord.enabled)}
          onChange={(enabled) => {
            void props.onSaveDiscord({
              ...discord,
              enabled: { ...discord.enabled, value: enabled },
            });
          }}
        />
        <SecretField
          disabled={props.saving || !discord.botToken.writable}
          label="Bot Token"
          secret="discordBotToken"
          state={discord.botToken}
          onClearSecret={props.onClearSecret}
          onReplaceSecret={props.onReplaceSecret}
        />
        <TextField
          disabled={props.saving}
          label="Application ID"
          source={optionalStringSourceBadge(discord.applicationId)}
          value={discord.applicationId.value}
          onSave={(applicationId) => {
            void props.onSaveDiscord({
              ...discord,
              applicationId: {
                ...discord.applicationId,
                value: applicationId,
              },
            });
          }}
        />
        <ListField
          disabled={props.saving}
          label="Authorized User IDs"
          source={optionalListSourceBadge(discord.authorizedUserIds)}
          value={discord.authorizedUserIds.value}
          onSave={(authorizedUserIds) => {
            void props.onSaveDiscord({
              ...discord,
              authorizedUserIds: {
                ...discord.authorizedUserIds,
                value: authorizedUserIds,
              },
            });
          }}
        />
        <ListField
          disabled={props.saving}
          label="Authorized Guilds"
          source={optionalListSourceBadge(discord.authorizedGuilds)}
          value={discord.authorizedGuilds.value}
          onSave={(authorizedGuilds) => {
            void props.onSaveDiscord({
              ...discord,
              authorizedGuilds: {
                ...discord.authorizedGuilds,
                value: authorizedGuilds,
              },
            });
          }}
        />
      </MessagingGroup>
    </section>
  );
}

const TOOL_UPDATE_MODE_OPTIONS: Array<{
  label: string;
  value: MessagingToolUpdateMode;
}> = [
  { label: "Show None", value: "show_none" },
  { label: "Show Less", value: "show_less" },
  { label: "Show Some", value: "show_some" },
  { label: "Show More", value: "show_more" },
  { label: "Show All", value: "show_all" },
];

function MessagingGroup(props: { children: ReactNode; title: string }) {
  return (
    <section className="settings-panel" aria-labelledby={`settings-${props.title}-title`}>
      <div className="settings-panel__header">
        <div>
          <p className="eyebrow">Messaging</p>
          <h2 id={`settings-${props.title}-title`}>{props.title}</h2>
        </div>
      </div>
      <div className="settings-fields">{props.children}</div>
    </section>
  );
}

function SegmentedField<TValue extends string>(props: {
  disabled?: boolean;
  label: string;
  options: Array<{ label: string; value: TValue }>;
  source: string;
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="settings-field">
      <div className="settings-row__label">{props.label}</div>
      <span className="settings-source">{props.source}</span>
      <div className="settings-segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((option) => (
          <button
            key={option.value}
            aria-checked={props.value === option.value}
            className={`settings-segmented__button${
              props.value === option.value ? " is-active" : ""
            }`}
            disabled={props.disabled}
            role="radio"
            type="button"
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleField(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  source: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="settings-row settings-row--toggle">
      <span>
        <span className="settings-row__label">{props.label}</span>
        <span className="settings-source">{props.source}</span>
      </span>
      <input
        checked={props.checked}
        disabled={props.disabled}
        type="checkbox"
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function TextField(props: {
  disabled?: boolean;
  label: string;
  source: string;
  value: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value);

  return (
    <label className="settings-row">
      <span className="settings-row__label">{props.label}</span>
      <span className="settings-source">{props.source}</span>
      <input
        className="settings-input"
        disabled={props.disabled}
        value={value}
        onBlur={() => props.onSave(value.trim())}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
    </label>
  );
}

function ListField(props: {
  disabled?: boolean;
  label: string;
  source: string;
  value: string[];
  onSave: (value: string[]) => void;
}) {
  const [value, setValue] = useState(joinListValue(props.value));

  return (
    <label className="settings-row">
      <span className="settings-row__label">{props.label}</span>
      <span className="settings-source">{props.source}</span>
      <input
        className="settings-input"
        disabled={props.disabled}
        value={value}
        onBlur={() => props.onSave(parseListValue(value))}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
    </label>
  );
}

function SecretField(props: {
  disabled?: boolean;
  label: string;
  secret: DesktopSettingsSecretName;
  state: DesktopSettingsSnapshot["models"]["grok"]["apiKey"];
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const status = props.state.configured ? "Set" : "Not set";
  const source = formatSourceLabel(props.state.source, props.state.overriddenByEnv);

  return (
    <div className="settings-row">
      <span className="settings-row__label">{props.label}</span>
      <span className="settings-source">{status} · {source}</span>
      <div className="settings-secret">
        <input
          aria-label={props.label}
          className="settings-input"
          disabled={props.disabled}
          placeholder="••••••••"
          type="password"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <button
          className="button button--secondary"
          disabled={props.disabled || !value.trim()}
          type="button"
          onClick={() => {
            const nextValue = value.trim();
            void props.onReplaceSecret(props.secret, nextValue).then((saved) => {
              if (saved) {
                setValue("");
              }
            });
          }}
        >
          Replace
        </button>
        <button
          className="button button--ghost"
          disabled={props.disabled || props.state.source === "env"}
          type="button"
          onClick={() => {
            void props.onClearSecret(props.secret);
          }}
        >
          Clear
        </button>
      </div>
      {props.state.unavailableReason ? (
        <span className="settings-row__error">{props.state.unavailableReason}</span>
      ) : null}
    </div>
  );
}
