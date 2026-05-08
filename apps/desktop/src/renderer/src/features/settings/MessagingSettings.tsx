import { useId, useState, type ReactNode } from "react";
import {
  validateDiscordSnowflake,
  validateMattermostId,
  validateTelegramPositiveId,
  validateTelegramSupergroupId,
  type DesktopAuthorizedContact,
  type DesktopMessagingContactLookupKind,
  type DesktopMessagingContactLookupPlatform,
  type DesktopMessagingContactLookupResponse,
  type IdentifierValidationResult,
  type DesktopSettingsSecretName,
  type DesktopSettingsSnapshot,
  type MessagingToolUpdateMode,
} from "@pwragent/shared";
import { DiscordIcon, MattermostIcon, TelegramIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  type SettingsChipTone,
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsTestBlock } from "./SettingsTestBlock";
import {
  formatSourceLabel,
  optionalListSourceBadge,
  optionalStringSourceBadge,
  sourceBadge,
} from "./settings-fields";

export function MessagingSettings(props: {
  desktopApi?: DesktopApi;
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
  onSaveMattermost: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["mattermost"]>,
  ) => Promise<void>;
}) {
  const telegram = props.snapshot.messaging.telegram;
  const discord = props.snapshot.messaging.discord;
  const mattermost = props.snapshot.messaging.mattermost;
  const toolUpdateMode = props.snapshot.messaging.toolUpdateMode;
  const inputDebounceMs = props.snapshot.messaging.inputDebounceMs;
  const runtimeMessaging = props.snapshot.runtime.messaging;

  return (
    <SettingsSectionStack paneId="messaging" aria-label="Messaging settings">
      <SettingsPanelHead
        eyebrow="Messaging"
        title="Connected chat platforms"
        help="Bridge PwrAgent threads to messaging platforms so you can drive runs from your phone. Tokens are stored in the system keychain. Authorization defaults closed: if no allowed IDs are configured, nothing can use that entry. Check the Messaging Activity window for rejected IDs to add here."
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
          <SettingsField
            label="Connection test"
            sub="Pings getMe on the Telegram Bot API."
            control={
              <SettingsTestBlock
                kind="telegram"
                desktopApi={props.desktopApi}
                icon={<TelegramIcon size={14} variant="color" />}
                defaultName="@your_bot"
                defaultSub="api.telegram.org"
              />
            }
          />
          <ToggleField
            checked={telegram.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses"
            sub="Send partial assistant tokens as Telegram message edits."
            help={STREAMING_RESPONSES_WARNING}
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
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(
              props.desktopApi,
              "telegram",
              "user",
            )}
            label="Authorized User IDs"
            sub="Telegram user IDs that can DM the bot."
            help="Numeric peer ID, e.g. 8460800771. Rejected Telegram DMs show the peer ID in Messaging Activity; use the numeric form, not @username."
            source={optionalListSourceBadge(telegram.authorizedUserIds)}
            validateEntry={validateTelegramUserIdEntry}
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
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(
              props.desktopApi,
              "telegram",
              "supergroup",
            )}
            label="Authorized SuperGroups"
            sub="Telegram supergroup IDs that may host bound threads."
            help="Negative ID starting with -100, e.g. -1003841603622. Rejected group messages show the supergroup ID in Messaging Activity."
            source={optionalListSourceBadge(telegram.authorizedSupergroups)}
            validateEntry={validateTelegramSupergroupEntry}
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
          <SettingsField
            label="Connection test"
            sub="Validates the bot token via /users/@me on the Discord API."
            control={
              <SettingsTestBlock
                kind="discord"
                desktopApi={props.desktopApi}
                icon={<DiscordIcon size={14} variant="white" />}
                defaultName="Your bot"
                defaultSub="discord.com/api/v10"
              />
            }
          />
          <ToggleField
            checked={discord.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses"
            sub="Send partial assistant tokens as Discord message edits."
            help={STREAMING_RESPONSES_WARNING}
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
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(
              props.desktopApi,
              "discord",
              "user",
            )}
            label="Authorized User IDs"
            sub="Discord user IDs that can DM the bot."
            help="Snowflake (17-19 digit number), e.g. 1177378744822943744. Rejected Discord messages show the user ID in Messaging Activity."
            source={optionalListSourceBadge(discord.authorizedUserIds)}
            validateEntry={validateDiscordUserIdEntry}
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
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(
              props.desktopApi,
              "discord",
              "guild",
            )}
            label="Authorized Guilds"
            sub="Discord guild (server) IDs that may host bound threads."
            help="Snowflake (17-19 digit number), e.g. 1480554271907905731. Rejected server messages show the guild ID in Messaging Activity."
            source={optionalListSourceBadge(discord.authorizedGuilds)}
            validateEntry={validateDiscordGuildIdEntry}
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

      <SettingsSection
        eyebrow="Messaging"
        title="Mattermost"
        chip={chipLabelForBotToken(mattermost.botToken)}
        chipKind={chipKindForBotToken(mattermost.botToken)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={mattermost.enabled.value}
            disabled={props.saving}
            label="Enabled"
            sub="Turn the Mattermost adapter on or off independently of the global messaging switch."
            source={sourceBadge(mattermost.enabled)}
            onChange={(enabled) => {
              void props.onSaveMattermost({
                ...mattermost,
                enabled: { ...mattermost.enabled, value: enabled },
              });
            }}
          />
          <SecretField
            disabled={props.saving || !mattermost.botToken.writable}
            label="Bot Token"
            sub="Stored in the system keychain. Generate from System Console → Integrations → Bot Accounts."
            secret="mattermostBotToken"
            state={mattermost.botToken}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <TextField
            disabled={props.saving}
            label="Server URL"
            sub="PwrAgent calls this URL. For small installations it can live on the same machine, or in Docker on the same machine."
            help={
              <>
                Examples:
                <br />
                <code>http://127.0.0.1:8065/</code> (local, Docker on same host)
                <br />
                <code>https://chat.example.com</code> (Cloudflare Tunnel / Tailscale Funnel)
              </>
            }
            source={optionalStringSourceBadge(mattermost.serverUrl)}
            value={mattermost.serverUrl.value}
            onSave={(serverUrl) => {
              void props.onSaveMattermost({
                ...mattermost,
                serverUrl: { ...mattermost.serverUrl, value: serverUrl },
              });
            }}
          />
          <SettingsField
            label="Connection test"
            sub="Validates the bot token via /api/v4/users/me on your Mattermost server."
            control={
              <SettingsTestBlock
                kind="mattermost"
                desktopApi={props.desktopApi}
                icon={<MattermostIcon size={14} />}
                defaultName="Your bot"
                defaultSub="api/v4/users/me"
              />
            }
          />
          <ToggleField
            checked={mattermost.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses"
            sub="Send partial assistant tokens as Mattermost message edits."
            help={STREAMING_RESPONSES_WARNING}
            source={sourceBadge(mattermost.streamingResponses)}
            onChange={(streamingResponses) => {
              void props.onSaveMattermost({
                ...mattermost,
                streamingResponses: {
                  ...mattermost.streamingResponses,
                  value: streamingResponses,
                },
              });
            }}
          />
          <TextField
            disabled={props.saving}
            label="Callback Base URL"
            sub="Mattermost calls PwrAgent at this URL when a user clicks a button. It must be reachable from the Mattermost server: a public URL (Cloudflare Tunnel / Tailscale Funnel) for hosted Mattermost, a name on the local network, or an address Mattermost-in-Docker can use to reach the PwrAgent process on the host. The local listener binds to the URL's port if present, otherwise to 47821."
            help={
              <>
                Examples:
                <br />
                <code>https://mm-callback.example.com/</code> (Cloudflare Tunnel / Tailscale Funnel)
                <br />
                <code>http://localhost:47821/</code> (local)
                <br />
                <code>http://host.docker.internal:47821/</code> (Mattermost in Docker on the same host)
              </>
            }
            source={optionalStringSourceBadge(mattermost.callbackBaseUrl)}
            value={mattermost.callbackBaseUrl.value}
            onSave={(callbackBaseUrl) => {
              void props.onSaveMattermost({
                ...mattermost,
                callbackBaseUrl: {
                  ...mattermost.callbackBaseUrl,
                  value: callbackBaseUrl,
                },
              });
            }}
          />
          <SecretField
            disabled={props.saving || !mattermost.hmacSecret.writable}
            label="Callback HMAC Secret"
            sub="Optional. Stored in the system keychain. Leave unset to regenerate per restart (acts as automatic TTL on outstanding callback URLs)."
            help={
              <>
                Click <strong>Generate</strong> to fill the field with a fresh
                256-bit secret (then click Replace to save), <em>or</em> run
                this in a terminal if you'd rather generate it yourself:
                <br />
                <code>openssl rand -hex 32</code>
              </>
            }
            secret="mattermostHmacSecret"
            state={mattermost.hmacSecret}
            onGenerate={generateHmacSecretHex}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <ToggleField
            checked={mattermost.registerSlashCommands.value}
            disabled={props.saving}
            label="Register slash commands"
            sub="Off by default. Mattermost 10.x slash-command bodies omit thread context, so responses land in the channel — use @bot help mentions instead. Mattermost 11.0+ supports threaded slash replies."
            source={sourceBadge(mattermost.registerSlashCommands)}
            onChange={(registerSlashCommands) => {
              void props.onSaveMattermost({
                ...mattermost,
                registerSlashCommands: {
                  ...mattermost.registerSlashCommands,
                  value: registerSlashCommands,
                },
              });
            }}
          />
          <TextField
            disabled={props.saving || !mattermost.registerSlashCommands.value}
            label="Slash command prefix"
            sub="Prefix prepended to every registered command (default pwragent_ → /pwragent_help). Set blank to register bare triggers and accept collision risk with built-in Mattermost commands."
            source={optionalStringSourceBadge(mattermost.slashCommandPrefix)}
            value={mattermost.slashCommandPrefix.value}
            onSave={(slashCommandPrefix) => {
              void props.onSaveMattermost({
                ...mattermost,
                slashCommandPrefix: {
                  ...mattermost.slashCommandPrefix,
                  value: slashCommandPrefix,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(
              props.desktopApi,
              "mattermost",
              "user",
            )}
            label="Authorized User IDs"
            sub="Mattermost user IDs that can DM the bot."
            help="26-character lowercase a-z0-9 ID. Rejected Mattermost messages show the user ID in Messaging Activity."
            source={optionalListSourceBadge(mattermost.authorizedUserIds)}
            validateEntry={validateMattermostUserIdEntry}
            value={mattermost.authorizedUserIds.value}
            onSave={(authorizedUserIds) => {
              void props.onSaveMattermost({
                ...mattermost,
                authorizedUserIds: {
                  ...mattermost.authorizedUserIds,
                  value: authorizedUserIds,
                },
              });
            }}
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
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

const STREAMING_RESPONSES_WARNING =
  "Leave this off unless you know you need live edits. Voice readers may speak each partial edit as a separate incomplete reply, and frequent edits can quickly hit platform rate limits.";

function chipLabelForBotToken(
  botToken: DesktopSettingsSnapshot["messaging"]["telegram"]["botToken"],
): ReactNode {
  if (botToken.source === "env") return "env override";
  if (botToken.configured) return "Configured";
  return "Not configured";
}

function chipKindForBotToken(
  botToken: DesktopSettingsSnapshot["messaging"]["telegram"]["botToken"],
): SettingsChipTone {
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
  help?: ReactNode;
  source: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
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
  help?: ReactNode;
  source: string;
  value: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value);

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
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

function AuthorizedListField(props: {
  disabled?: boolean;
  help?: ReactNode;
  label: string;
  lookup?: (id: string) => Promise<DesktopMessagingContactLookupResponse>;
  sub?: ReactNode;
  source: string;
  validateEntry?: (value: string) => string | undefined;
  value: DesktopAuthorizedContact[];
  onSave: (value: DesktopAuthorizedContact[]) => void;
}) {
  const inputId = useId();
  const descriptionId = `${inputId}-validation`;
  const [rows, setRows] = useState<DesktopAuthorizedContact[]>(props.value);
  const [lookupState, setLookupState] = useState<
    Record<number, { loading?: boolean; message?: string }>
  >({});
  const normalizedRows = rows.map(normalizeAuthorizedContactRow);
  const invalidEntries = props.validateEntry
    ? normalizedRows
        .map((row, index) => ({
          entry: row.id,
          index,
          message:
            row.id.length > 0
              ? props.validateEntry?.(row.id)
              : row.displayName.length > 0
                ? "ID cannot be blank when a display name is set."
                : undefined,
        }))
        .filter(
          (result): result is { entry: string; index: number; message: string } =>
            Boolean(result.message),
        )
    : [];
  const hasInvalidEntries = invalidEntries.length > 0;

  const saveIfValid = (nextRows: DesktopAuthorizedContact[]) => {
    const normalized = nextRows.map(normalizeAuthorizedContactRow);
    if (
      props.validateEntry &&
      normalized.some(
        (row) =>
          (row.id.length > 0 && props.validateEntry?.(row.id))
          || (row.id.length === 0 && row.displayName.length > 0),
      )
    ) {
      return;
    }
    props.onSave(normalized.filter((row) => row.id.length > 0));
  };

  const updateRow = (
    indexToUpdate: number,
    patch: Partial<DesktopAuthorizedContact>,
  ) => {
    setLookupState((current) => {
      const { [indexToUpdate]: _discard, ...rest } = current;
      return rest;
    });
    setRows((current) =>
      current.map((row, index) =>
        index === indexToUpdate ? { ...row, ...patch } : row,
      ),
    );
  };

  const removeEntry = (indexToRemove: number) => {
    const nextRows = rows.filter((_, index) => index !== indexToRemove);
    setRows(nextRows);
    saveIfValid(nextRows);
  };

  const lookupRow = async (
    indexToLookup: number,
    candidateRows: DesktopAuthorizedContact[],
  ) => {
    const lookup = props.lookup;
    if (!lookup) return;
    const row = normalizeAuthorizedContactRow(candidateRows[indexToLookup] ?? {
      id: "",
      displayName: "",
    });
    if (!row.id || props.validateEntry?.(row.id)) return;

    setLookupState((current) => ({
      ...current,
      [indexToLookup]: { loading: true },
    }));
    let result: DesktopMessagingContactLookupResponse;
    try {
      result = await lookup(row.id);
    } catch (error) {
      result = {
        status: "failed",
        id: row.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.status === "ok" && result.displayName) {
      const nextRows = candidateRows.map((current, rowIndex) =>
        rowIndex === indexToLookup
          ? { id: row.id, displayName: result.displayName ?? "" }
          : current,
      );
      setRows(nextRows);
      setLookupState((current) => {
        const { [indexToLookup]: _discard, ...rest } = current;
        return rest;
      });
      saveIfValid(nextRows);
      return;
    }

    setLookupState((current) => ({
      ...current,
      [indexToLookup]: {
        message: lookupFailureMessage(result),
      },
    }));
  };

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
      source={props.source}
      error={
        hasInvalidEntries
          ? "Fix or remove invalid IDs before saving this setting."
          : undefined
      }
      control={
        <>
          <div className="settings-authorized-list">
            {rows.map((row, index) => {
              const normalized = normalizedRows[index] ?? {
                id: "",
                displayName: "",
              };
              const invalid = invalidEntries.find(
                (entry) => entry.index === index,
              );
              const lookup = lookupState[index];
              const canLookup =
                Boolean(props.lookup)
                && normalized.id.length > 0
                && !invalid
                && !props.disabled
                && !lookup?.loading;
              return (
                <div
                  key={index}
                  className="settings-authorized-list__row"
                >
                  <input
                    aria-describedby={invalid ? descriptionId : undefined}
                    aria-invalid={invalid ? "true" : undefined}
                    aria-label={`${props.label} ID ${index + 1}`}
                    className={`settings-input settings-authorized-list__id${
                      invalid ? " settings-input--invalid" : ""
                    }`}
                    disabled={props.disabled}
                    placeholder="ID"
                    value={row.id}
                    onBlur={() => {
                      const nextRows = rows.map((current, rowIndex) =>
                        rowIndex === index ? normalized : current,
                      );
                      setRows(nextRows);
                      saveIfValid(nextRows);
                      if (normalized.displayName.length === 0) {
                        void lookupRow(index, nextRows);
                      }
                    }}
                    onChange={(event) =>
                      updateRow(index, { id: event.currentTarget.value })
                    }
                  />
                  <input
                    aria-label={`${props.label} display name ${index + 1}`}
                    className="settings-input settings-authorized-list__name"
                    disabled={props.disabled}
                    maxLength={64}
                    placeholder="Display name"
                    value={row.displayName}
                    onBlur={() => {
                      const nextRows = rows.map((current, rowIndex) =>
                        rowIndex === index ? normalized : current,
                      );
                      setRows(nextRows);
                      saveIfValid(nextRows);
                    }}
                    onChange={(event) =>
                      updateRow(index, {
                        displayName: event.currentTarget.value,
                      })
                    }
                  />
                  <button
                    aria-label={`Lookup ${props.label} row ${index + 1}`}
                    className="button button--ghost settings-authorized-list__lookup"
                    disabled={!canLookup}
                    type="button"
                    onClick={() => {
                      void lookupRow(index, rows);
                    }}
                  >
                    {lookup?.loading ? "Looking..." : "Lookup"}
                  </button>
                  <button
                    aria-label={`Remove ${props.label} row ${index + 1}`}
                    className="button button--ghost settings-authorized-list__remove"
                    disabled={props.disabled}
                    type="button"
                    onClick={() => removeEntry(index)}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            <button
              className="button button--secondary settings-authorized-list__add"
              disabled={props.disabled}
              type="button"
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { id: "", displayName: "" },
                ])
              }
            >
              Add
            </button>
          </div>
          {Object.entries(lookupState).some(([, state]) => state.message) ? (
            <div className="settings-list-validation" role="status">
              {Object.entries(lookupState)
                .filter(([, state]) => state.message)
                .map(([index, state]) => (
                  <div
                    key={`lookup-${index}`}
                    className="settings-list-validation__item"
                  >
                    <span className="settings-list-validation__message">
                      {state.message}
                    </span>
                  </div>
                ))}
            </div>
          ) : null}
          {hasInvalidEntries ? (
            <div
              id={descriptionId}
              className="settings-list-validation"
              role="status"
            >
              {invalidEntries.map((invalid) => (
                <div
                  key={`${invalid.index}-${invalid.entry}`}
                  className="settings-list-validation__item"
                >
                  <span className="settings-list-validation__message">
                    <code>{invalid.entry || "(blank)"}</code>
                    {" — "}
                    {invalid.message}
                  </span>
                  <button
                    className="button button--ghost settings-list-validation__remove"
                    disabled={props.disabled}
                    type="button"
                    onClick={() => removeEntry(invalid.index)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      }
    />
  );
}

function contactLookup(
  desktopApi: DesktopApi | undefined,
  platform: DesktopMessagingContactLookupPlatform,
  kind: DesktopMessagingContactLookupKind,
): ((id: string) => Promise<DesktopMessagingContactLookupResponse>) | undefined {
  const lookup = desktopApi?.resolveMessagingContact;
  if (!lookup) {
    return undefined;
  }
  return async (id: string) =>
    await lookup({
      platform,
      kind,
      id,
    });
}

function lookupFailureMessage(
  result: DesktopMessagingContactLookupResponse,
): string {
  switch (result.status) {
    case "unset":
      return "Configure the platform token before looking up names.";
    case "not_found":
      return result.errorMessage ?? "No matching platform identity was found.";
    case "unsupported":
      return result.errorMessage ?? "Lookup is not supported for this row.";
    case "ok":
      return "No display name was returned for this ID.";
    case "failed":
      return result.errorMessage ?? "Lookup failed.";
  }
}

function normalizeAuthorizedContactRow(
  contact: DesktopAuthorizedContact,
): DesktopAuthorizedContact {
  return {
    id: contact.id.trim(),
    displayName: contact.displayName
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64),
  };
}

function validateTelegramUserIdEntry(value: string): string | undefined {
  return validationMessage(
    validateTelegramPositiveId(value),
    "Telegram user ID",
    {
      format:
        value.startsWith("@") || /^[A-Za-z][A-Za-z0-9_]*$/.test(value)
          ? "That looks like a Telegram username, not a peer ID. Use the numeric form (e.g. 8460800771)."
          : "Use a positive numeric Telegram peer ID, e.g. 8460800771.",
      length: "Telegram peer IDs must fit the decimal numeric ID form.",
      range: "Use a positive Telegram peer ID, e.g. 8460800771.",
    },
  );
}

function validateTelegramSupergroupEntry(value: string): string | undefined {
  return validationMessage(
    validateTelegramSupergroupId(value),
    "Telegram supergroup ID",
    {
      format:
        "Use the negative supergroup ID starting with -100, e.g. -1003841603622.",
      length: "Telegram supergroup IDs must fit the decimal numeric ID form.",
      range:
        "Use the negative supergroup ID starting with -100, e.g. -1003841603622.",
    },
  );
}

function validateDiscordUserIdEntry(value: string): string | undefined {
  return validationMessage(validateDiscordSnowflake(value), "Discord user ID", {
    format: "Use the numeric Discord snowflake, e.g. 1177378744822943744.",
    future: "That snowflake timestamp is in the future. Copy the user ID from Messaging Activity.",
    length: "Discord IDs are snowflakes: 17-19 digits.",
    range: "Use a positive Discord snowflake, e.g. 1177378744822943744.",
  });
}

function validateDiscordGuildIdEntry(value: string): string | undefined {
  return validationMessage(validateDiscordSnowflake(value), "Discord guild ID", {
    format: "Use the numeric Discord guild snowflake, e.g. 1480554271907905731.",
    future: "That snowflake timestamp is in the future. Copy the guild ID from Messaging Activity.",
    length: "Discord guild IDs are snowflakes: 17-19 digits.",
    range: "Use a positive Discord guild snowflake, e.g. 1480554271907905731.",
  });
}

function validateMattermostUserIdEntry(value: string): string | undefined {
  return validationMessage(validateMattermostId(value), "Mattermost user ID", {
    format: "Use the 26-character lowercase a-z0-9 Mattermost user ID.",
    length: "Mattermost user IDs are exactly 26 lowercase a-z0-9 characters.",
  });
}

function validationMessage(
  result: IdentifierValidationResult,
  label: string,
  messages: Partial<
    Record<Exclude<IdentifierValidationResult, { ok: true }>["reason"], string>
  >,
): string | undefined {
  if (result.ok) return undefined;
  if (result.reason === "empty") return `${label} cannot be blank.`;
  if (result.reason === "type") return `${label} must be a string.`;
  return messages[result.reason] ?? `${label} has the wrong format.`;
}

function SecretField(props: {
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  help?: ReactNode;
  secret: DesktopSettingsSecretName;
  state: DesktopSettingsSnapshot["models"]["grok"]["apiKey"];
  /**
   * Optional generator. When provided, a "Generate" button appears
   * that fills the input with the produced value (the user still has
   * to click Replace to commit). Used by the Mattermost HMAC field
   * so users don't have to leave the app to run openssl.
   */
  onGenerate?: () => string;
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
      help={props.help}
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
          {props.onGenerate ? (
            <button
              className="button button--ghost"
              disabled={props.disabled}
              type="button"
              onClick={() => {
                setValue(props.onGenerate!());
              }}
            >
              Generate
            </button>
          ) : null}
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

/**
 * Generate a 32-byte (256-bit) hex secret using the renderer's Web
 * Crypto API. Equivalent strength to `openssl rand -hex 32`. Browser
 * `crypto.getRandomValues` is a CSPRNG in Electron just like in
 * Chrome, so we don't need to bounce through the main process.
 */
function generateHmacSecretHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
