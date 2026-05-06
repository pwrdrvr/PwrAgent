import { useState, type ReactNode } from "react";
import type {
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
  MessagingToolUpdateMode,
} from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  type SettingsCardChipKind,
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
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
  onInputDebounceMsChange: (value: number) => Promise<void>;
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
  const inputDebounceMs = props.snapshot.messaging.inputDebounceMs;
  const runtimeMessaging = props.snapshot.runtime.messaging;

  return (
    <section className="settings-stack" aria-label="Messaging settings">
      <SettingsPanelHead
        eyebrow="Messaging"
        title="Connected chat platforms"
        help="Bridge PwrAgent threads to messaging platforms so you can drive runs from your phone. Tokens are stored in the system keychain. Each platform's enabled switch is independent of the global messaging switch."
      />

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

      <SettingsSection eyebrow="Messaging" title="General">
        <div className="settings-fields">
          <SegmentedField
            disabled={props.saving}
            label="Tool usage notifications"
            sub="How chatty bridged messages are when the agent runs tools."
            options={TOOL_UPDATE_MODE_OPTIONS}
            source={sourceBadge(toolUpdateMode)}
            value={toolUpdateMode.value}
            onChange={(mode) => {
              void props.onToolUpdateModeChange(mode);
            }}
          />
          <NumberField
            disabled={props.saving}
            label="Input debounce"
            sub="Wait this long for split text, code blocks, images, or files before starting one agent turn."
            help="Use 0 to disable the pre-start wait."
            max={5000}
            min={0}
            source={sourceBadge(inputDebounceMs)}
            suffix="ms"
            value={inputDebounceMs.value}
            onSave={props.onInputDebounceMsChange}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Messaging"
        title="Telegram"
        chip={chipLabelForBotToken(telegram.botToken)}
        chipKind={chipKindForBotToken(telegram.botToken)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={telegram.enabled.value}
            disabled={props.saving}
            label="Enabled"
            sub="Turn the Telegram adapter on or off independently of the global messaging switch."
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
            sub="Stored in the system keychain."
            secret="telegramBotToken"
            state={telegram.botToken}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <ToggleField
            checked={telegram.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses"
            sub="Send partial assistant tokens as Telegram message edits."
            source={sourceBadge(telegram.streamingResponses)}
            onChange={(streamingResponses) => {
              void props.onSaveTelegram({
                ...telegram,
                streamingResponses: {
                  ...telegram.streamingResponses,
                  value: streamingResponses,
                },
              });
            }}
          />
          <ListField
            disabled={props.saving}
            label="Authorized User IDs"
            sub="Comma-separated Telegram user IDs that can DM the bot."
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
            sub="Comma-separated Telegram supergroup IDs that may host bound threads."
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
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Messaging"
        title="Discord"
        chip={chipLabelForBotToken(discord.botToken)}
        chipKind={chipKindForBotToken(discord.botToken)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={discord.enabled.value}
            disabled={props.saving}
            label="Enabled"
            sub="Turn the Discord adapter on or off independently of the global messaging switch."
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
            sub="Stored in the system keychain."
            secret="discordBotToken"
            state={discord.botToken}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <ToggleField
            checked={discord.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses"
            sub="Send partial assistant tokens as Discord message edits."
            source={sourceBadge(discord.streamingResponses)}
            onChange={(streamingResponses) => {
              void props.onSaveDiscord({
                ...discord,
                streamingResponses: {
                  ...discord.streamingResponses,
                  value: streamingResponses,
                },
              });
            }}
          />
          <TextField
            disabled={props.saving}
            label="Application ID"
            sub="Discord application ID (snowflake) for slash commands."
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
            sub="Comma-separated Discord user IDs that can DM the bot."
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
            sub="Comma-separated Discord guild (server) IDs that may host bound threads."
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
        </div>
      </SettingsSection>
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

function chipLabelForBotToken(
  botToken: DesktopSettingsSnapshot["messaging"]["telegram"]["botToken"],
): ReactNode {
  if (botToken.source === "env") return "env override";
  if (botToken.configured) return "Configured";
  return "Not configured";
}

function chipKindForBotToken(
  botToken: DesktopSettingsSnapshot["messaging"]["telegram"]["botToken"],
): SettingsCardChipKind {
  if (botToken.source === "env") return "warn";
  if (botToken.configured) return "ok";
  return "default";
}

function SegmentedField<TValue extends string>(props: {
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  options: Array<{ label: string; value: TValue }>;
  source: string;
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      source={props.source}
      control={
        <div
          className="settings-segmented"
          role="radiogroup"
          aria-label={props.label}
        >
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
      }
    />
  );
}

function ToggleField(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  source: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      source={props.source}
      control={
        <SettingsSwitch
          checked={props.checked}
          disabled={props.disabled}
          label={props.label}
          onChange={props.onChange}
        />
      }
    />
  );
}

function TextField(props: {
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  source: string;
  value: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value);

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      source={props.source}
      control={
        <input
          aria-label={props.label}
          className="settings-input"
          disabled={props.disabled}
          value={value}
          onBlur={() => props.onSave(value.trim())}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      }
    />
  );
}

function NumberField(props: {
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  help?: ReactNode;
  max?: number;
  min?: number;
  source: string;
  suffix?: string;
  value: number;
  onSave: (value: number) => void;
}) {
  const [value, setValue] = useState(String(props.value));

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
      source={props.source}
      control={
        <span className="settings-number">
          <input
            aria-label={props.label}
            className="settings-input settings-input--inline"
            disabled={props.disabled}
            max={props.max}
            min={props.min}
            type="number"
            value={value}
            onBlur={() => {
              const parsed = Number(value);
              if (!Number.isFinite(parsed)) {
                setValue(String(props.value));
                return;
              }
              const clamped = Math.min(
                Math.max(
                  Math.trunc(parsed),
                  props.min ?? Number.MIN_SAFE_INTEGER,
                ),
                props.max ?? Number.MAX_SAFE_INTEGER,
              );
              setValue(String(clamped));
              props.onSave(clamped);
            }}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          {props.suffix ? (
            <span className="settings-source">{props.suffix}</span>
          ) : null}
        </span>
      }
    />
  );
}

function ListField(props: {
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  source: string;
  value: string[];
  onSave: (value: string[]) => void;
}) {
  const [value, setValue] = useState(joinListValue(props.value));

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      source={props.source}
      control={
        <input
          aria-label={props.label}
          className="settings-input"
          disabled={props.disabled}
          value={value}
          onBlur={() => props.onSave(parseListValue(value))}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      }
    />
  );
}

function SecretField(props: {
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
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
    <SettingsField
      label={props.label}
      sub={props.sub}
      source={`${status} · ${source}`}
      error={props.state.unavailableReason}
      control={
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
      }
    />
  );
}
