import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  validateDiscordSnowflake,
  validateFeishuChatId,
  validateFeishuOpenId,
  validateFeishuTenantKey,
  validateLineGroupId,
  validateLineRoomId,
  validateLineUserId,
  validateMattermostId,
  validateSlackTeamId,
  validateSlackUserId,
  sanitizeMessagingContactLabel,
  validateTelegramGroupChatId,
  validateTelegramPositiveId,
  type DesktopAuthorizedContact,
  type DesktopMessagingContactLookupKind,
  type DesktopMessagingContactLookupPlatform,
  type DesktopMessagingContactLookupResponse,
  type IdentifierValidationResult,
  type DesktopSettingsSecretName,
  type DesktopSettingsSnapshot,
  type MessagingChannelKind,
  type MessagingPairingEntry,
  type MessagingPairingScope,
  type MessagingToolUpdateMode,
} from "@pwragent/shared";
import { DiscordIcon, FeishuIcon, LineIcon, MattermostIcon, SlackIcon, TelegramIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
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
  onMessagingEnabledChange: (enabled: boolean) => Promise<void>;
  onPairingSettingsChanged?: () => Promise<void>;
  onSaveDiscord: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["discord"]>,
  ) => Promise<void>;
  onSaveTelegram: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["telegram"]>,
  ) => Promise<void>;
  onSaveMattermost: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["mattermost"]>,
  ) => Promise<void>;
  onSaveSlack: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["slack"]>,
  ) => Promise<void>;
  onSaveFeishu: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["feishu"]>,
  ) => Promise<void>;
  onSaveLine: (
    patch: NonNullable<DesktopSettingsSnapshot["messaging"]["line"]>,
  ) => Promise<void>;
}) {
  const telegram = props.snapshot.messaging.telegram;
  const discord = props.snapshot.messaging.discord;
  const mattermost = props.snapshot.messaging.mattermost;
  const slack = props.snapshot.messaging.slack;
  const feishu = props.snapshot.messaging.feishu;
  const line = props.snapshot.messaging.line;
  const messagingEnabled = props.snapshot.messaging.enabled;
  const toolUpdateMode = props.snapshot.messaging.toolUpdateMode;
  const inputDebounceMs = props.snapshot.messaging.inputDebounceMs;
  const runtimeMessaging = props.snapshot.runtime.messaging;
  const masterEnabled = runtimeMessaging.overrideActive
    ? !runtimeMessaging.disabled
    : messagingEnabled.value;
  const platformControlsDisabled = props.saving || !masterEnabled;

  return (
    <SettingsSectionStack paneId="messaging" aria-label="Messaging settings">
      <SettingsPanelHead
        eyebrow="Messaging"
        title="Connected chat platforms"
        help="Bridge PwrAgent threads to messaging platforms so you can drive runs from your phone. Tokens are stored in the system keychain. Authorization defaults closed: if no allowed IDs are configured, inbound messages are discarded but logged in Messaging Activity so you can copy IDs into the allowlist."
      />

      {runtimeMessaging.overrideActive && runtimeMessaging.disabled ? (
        <section className="settings-panel settings-panel--warning" role="status">
          <div className="settings-panel__header">
            <div>
              <p className="eyebrow">Runtime Override</p>
              <h2>Messaging disabled for this app instance</h2>
            </div>
          </div>
          <p className="settings-row__description">
            Messaging is off because the app was launched with the no-messaging
            flag. You can override this for the current session by flipping the
            master toggle below, but make sure messaging is off in any other
            PwrAgent instances first. The override applies to this session only;
            the saved default is unchanged.
          </p>
        </section>
      ) : null}

      <SettingsSection eyebrow="Messaging" title="General">
        <div className="settings-fields">
          <ToggleField
            checked={masterEnabled}
            disabled={
              props.saving
              || (runtimeMessaging.overrideActive
                && !props.desktopApi?.setMessagingEnabled)
            }
            label="Messaging"
            sub={
              runtimeMessaging.overrideActive
                ? "Session-only master switch. The saved default is unchanged while the launch override is active."
                : "Master switch for all messaging adapters."
            }
            source={
              runtimeMessaging.overrideActive
                ? "session"
                : sourceBadge(messagingEnabled)
            }
            onChange={(enabled) => {
              void props.onMessagingEnabledChange(enabled);
            }}
          />
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
            disabled={platformControlsDisabled}
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
          <PairingTokenField
            desktopApi={props.desktopApi}
            disabled={platformControlsDisabled || !telegram.enabled.value}
            onSettingsChanged={props.onPairingSettingsChanged}
            platform="telegram"
            scopeOptions={TELEGRAM_PAIRING_SCOPE_OPTIONS}
            supportsBucket
          />
          <ToggleField
            checked={telegram.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses (Advanced)"
            sub="Sends partial assistant text as Telegram message edits."
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
            help="Numeric peer ID, e.g. 5550199999. Rejected Telegram DMs show the peer ID in Messaging Activity; use the numeric form, not @username."
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
            label="Authorized Groups / Supergroups"
            sub="Telegram group or supergroup IDs that may host bound threads."
            help="Use the negative chat ID shown in Messaging Activity for the Telegram group or supergroup."
            source={optionalListSourceBadge(telegram.authorizedSupergroups)}
            validateEntry={validateTelegramGroupChatEntry}
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
            disabled={platformControlsDisabled}
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
          <PairingTokenField
            desktopApi={props.desktopApi}
            disabled={platformControlsDisabled || !discord.enabled.value}
            onSettingsChanged={props.onPairingSettingsChanged}
            platform="discord"
            supportsBucket
          />
          <ToggleField
            checked={discord.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses (Advanced)"
            sub="Sends partial assistant text as Discord message edits."
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
            disabled={platformControlsDisabled}
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
          <PairingTokenField
            desktopApi={props.desktopApi}
            disabled={platformControlsDisabled || !mattermost.enabled.value}
            onSettingsChanged={props.onPairingSettingsChanged}
            platform="mattermost"
          />
          <ToggleField
            checked={mattermost.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses (Advanced)"
            sub="Sends partial assistant text as Mattermost message edits."
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
                256-bit secret (then click Save to commit), <em>or</em> run
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
          <AuthorizedListField
            disabled={props.saving}
            label="Authorized Teams"
            sub="Mattermost team IDs allowed for shared channel access."
            help="26-character lowercase a-z0-9 Mattermost team ID. Rejected Mattermost messages show the team ID in Messaging Activity when available."
            source={optionalListSourceBadge(mattermost.authorizedTeams)}
            validateEntry={validateMattermostTeamIdEntry}
            value={mattermost.authorizedTeams.value}
            onSave={(authorizedTeams) => {
              void props.onSaveMattermost({
                ...mattermost,
                authorizedTeams: {
                  ...mattermost.authorizedTeams,
                  value: authorizedTeams,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            label="Authorized Conversations"
            sub="Mattermost channel or group DM IDs allowed even without allowing the whole team."
            help="26-character lowercase a-z0-9 Mattermost channel ID. Rejected Mattermost messages show the channel ID in Messaging Activity."
            source={optionalListSourceBadge(mattermost.authorizedConversations)}
            validateEntry={validateMattermostConversationIdEntry}
            value={mattermost.authorizedConversations.value}
            onSave={(authorizedConversations) => {
              void props.onSaveMattermost({
                ...mattermost,
                authorizedConversations: {
                  ...mattermost.authorizedConversations,
                  value: authorizedConversations,
                },
              });
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Messaging"
        title="Slack"
        chip={chipLabelForBotToken(slack.botToken)}
        chipKind={chipKindForBotToken(slack.botToken)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={slack.enabled.value}
            disabled={platformControlsDisabled}
            label="Enabled"
            sub="Turn the Slack adapter on or off independently of the global messaging switch."
            source={sourceBadge(slack.enabled)}
            onChange={(enabled) => {
              void props.onSaveSlack({
                ...slack,
                enabled: { ...slack.enabled, value: enabled },
              });
            }}
          />
          <SecretField
            disabled={props.saving || !slack.botToken.writable}
            label="Bot Token"
            sub="Stored in the system keychain. Use a Slack bot token that starts with xoxb-."
            secret="slackBotToken"
            state={slack.botToken}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <SecretField
            disabled={props.saving || !slack.appToken.writable}
            label="App Token"
            sub="Stored in the system keychain. Required for Socket Mode; starts with xapp-."
            secret="slackAppToken"
            state={slack.appToken}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <SettingsField
            label="Connection test"
            sub="Validates the bot token with Slack auth.test."
            control={
              <SettingsTestBlock
                kind="slack"
                desktopApi={props.desktopApi}
                icon={<SlackIcon size={14} />}
                defaultName="Your bot"
                defaultSub="auth.test"
              />
            }
          />
          <PairingTokenField
            desktopApi={props.desktopApi}
            disabled={platformControlsDisabled || !slack.enabled.value}
            onSettingsChanged={props.onPairingSettingsChanged}
            platform="slack"
            supportsBucket
          />
          <TextField
            disabled={props.saving}
            label="Workspace URL"
            sub="Optional display URL for the Slack workspace."
            help={<code>https://example.slack.com</code>}
            source={optionalStringSourceBadge(slack.workspaceUrl)}
            value={slack.workspaceUrl.value}
            onSave={(workspaceUrl) => {
              void props.onSaveSlack({
                ...slack,
                workspaceUrl: { ...slack.workspaceUrl, value: workspaceUrl },
              });
            }}
          />
          <SegmentedField
            disabled={props.saving}
            label="Inbound Mode"
            sub="Socket Mode keeps Slack callbacks on an outbound WebSocket. Events API is reserved for a future HTTP callback path."
            options={SLACK_INBOUND_MODE_OPTIONS}
            source={sourceBadge(slack.inboundMode)}
            value={slack.inboundMode.value === "events" ? "socket" : slack.inboundMode.value}
            onChange={(inboundMode) => {
              void props.onSaveSlack({
                ...slack,
                inboundMode: { ...slack.inboundMode, value: inboundMode },
              });
            }}
          />
          <SecretField
            disabled={props.saving || !slack.signingSecret.writable}
            label="Signing Secret"
            sub="Optional for Socket Mode button validation. Required for future Events API mode."
            secret="slackSigningSecret"
            state={slack.signingSecret}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <ToggleField
            checked={slack.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses (Advanced)"
            sub="Sends partial assistant text as Slack message edits."
            help={STREAMING_RESPONSES_WARNING}
            source={sourceBadge(slack.streamingResponses)}
            onChange={(streamingResponses) => {
              void props.onSaveSlack({
                ...slack,
                streamingResponses: {
                  ...slack.streamingResponses,
                  value: streamingResponses,
                },
              });
            }}
          />
          <ToggleField
            checked={slack.registerSlashCommands.value}
            disabled={props.saving}
            label="Register slash commands"
            sub="Reserved for Slack app command setup. Leave off unless your app is configured for PwrAgent slash commands."
            source={sourceBadge(slack.registerSlashCommands)}
            onChange={(registerSlashCommands) => {
              void props.onSaveSlack({
                ...slack,
                registerSlashCommands: {
                  ...slack.registerSlashCommands,
                  value: registerSlashCommands,
                },
              });
            }}
          />
          <TextField
            disabled={props.saving || !slack.registerSlashCommands.value}
            label="Slash command prefix"
            sub="Prefix prepended to canonical commands (default pwragent_ → /pwragent_help)."
            source={optionalStringSourceBadge(slack.slashCommandPrefix)}
            value={slack.slashCommandPrefix.value}
            onSave={(slashCommandPrefix) => {
              void props.onSaveSlack({
                ...slack,
                slashCommandPrefix: {
                  ...slack.slashCommandPrefix,
                  value: slashCommandPrefix,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(
              props.desktopApi,
              "slack",
              "user",
            )}
            label="Authorized User IDs"
            sub="Slack user IDs that can DM or mention the bot."
            help="Slack user IDs start with U or W, e.g. U012ABCDEF0. Rejected Slack messages show the user ID in Messaging Activity."
            source={optionalListSourceBadge(slack.authorizedUserIds)}
            validateEntry={validateSlackUserIdEntry}
            value={slack.authorizedUserIds.value}
            onSave={(authorizedUserIds) => {
              void props.onSaveSlack({
                ...slack,
                authorizedUserIds: {
                  ...slack.authorizedUserIds,
                  value: authorizedUserIds,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(
              props.desktopApi,
              "slack",
              "workspace",
            )}
            label="Authorized Workspaces"
            sub="Optional Slack workspace/team IDs allowed for this bot."
            help="Slack workspace IDs start with T, e.g. T012ABCDEF0."
            source={optionalListSourceBadge(slack.authorizedWorkspaces)}
            validateEntry={validateSlackWorkspaceIdEntry}
            value={slack.authorizedWorkspaces.value}
            onSave={(authorizedWorkspaces) => {
              void props.onSaveSlack({
                ...slack,
                authorizedWorkspaces: {
                  ...slack.authorizedWorkspaces,
                  value: authorizedWorkspaces,
                },
              });
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Messaging"
        title="Feishu / Lark"
        chip={chipLabelForBotToken(feishu.appSecret)}
        chipKind={chipKindForBotToken(feishu.appSecret)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={feishu.enabled.value}
            disabled={platformControlsDisabled}
            label="Enabled"
            sub="Turn the Feishu / Lark adapter on or off independently of the global messaging switch."
            source={sourceBadge(feishu.enabled)}
            onChange={(enabled) => {
              void props.onSaveFeishu({
                ...feishu,
                enabled: { ...feishu.enabled, value: enabled },
              });
            }}
          />
          <SecretField
            disabled={props.saving || !feishu.appId.writable}
            label="App ID"
            sub="Stored in the system keychain. Required before going online in Lark Developer to verify and enable persistent events and callbacks."
            secret="feishuAppId"
            state={feishu.appId}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <SecretField
            disabled={props.saving || !feishu.appSecret.writable}
            label="App Secret"
            sub="Stored in the system keychain. Required before going online in Lark Developer to verify and enable persistent events and callbacks."
            secret="feishuAppSecret"
            state={feishu.appSecret}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <SettingsField
            label="Connection test"
            sub="Validates App ID and App Secret with the tenant token and app self-info APIs."
            control={
              <SettingsTestBlock
                kind="feishu"
                desktopApi={props.desktopApi}
                icon={<FeishuIcon size={14} />}
                defaultName="Your Feishu app"
                defaultSub="application self"
              />
            }
          />
          <PairingTokenField
            desktopApi={props.desktopApi}
            disabled={platformControlsDisabled || !feishu.enabled.value}
            onSettingsChanged={props.onPairingSettingsChanged}
            platform="feishu"
            supportsBucket
          />
          <SegmentedField
            disabled={props.saving}
            label="Event subscription"
            sub="Persistent connection is the default. After App ID and App Secret are configured, go online in Lark Developer to verify and enable Event Configuration and Callback Configuration."
            options={FEISHU_INBOUND_MODE_OPTIONS}
            source={sourceBadge(feishu.inboundMode)}
            value={feishu.inboundMode.value}
            onChange={(inboundMode) => {
              void props.onSaveFeishu({
                ...feishu,
                inboundMode: { ...feishu.inboundMode, value: inboundMode },
              });
            }}
          />
          <SegmentedField
            disabled={props.saving}
            label="Tenant region"
            sub="Feishu is China only. Lark is for the rest of the world."
            options={FEISHU_TENANT_REGION_OPTIONS}
            source={sourceBadge(feishu.tenantRegion)}
            value={feishu.tenantRegion.value}
            onChange={(tenantRegion) => {
              void props.onSaveFeishu({
                ...feishu,
                tenantRegion: { ...feishu.tenantRegion, value: tenantRegion },
              });
            }}
          />
          <TextField
            disabled={props.saving}
            label="Tenant URL"
            sub="Optional Open Platform endpoint override."
            help={
              <>
                Leave blank to use <code>https://open.feishu.cn</code> for
                Feishu or <code>https://open.larksuite.com</code> for Lark.
              </>
            }
            source={optionalStringSourceBadge(feishu.tenantUrl)}
            value={feishu.tenantUrl.value}
            onSave={(tenantUrl) => {
              void props.onSaveFeishu({
                ...feishu,
                tenantUrl: { ...feishu.tenantUrl, value: tenantUrl },
              });
            }}
          />
          {feishu.inboundMode.value === "webhook" ? (
            <TextField
              disabled={props.saving}
              label="Local Webhook Listener"
              sub="Only used when Webhook is selected for Event subscription."
              help={<>Default: <code>http://127.0.0.1:47823</code></>}
              source={optionalStringSourceBadge(feishu.callbackBaseUrl)}
              value={feishu.callbackBaseUrl.value}
              onSave={(callbackBaseUrl) => {
                void props.onSaveFeishu({
                  ...feishu,
                  callbackBaseUrl: {
                    ...feishu.callbackBaseUrl,
                    value: callbackBaseUrl,
                  },
                });
              }}
            />
          ) : null}
          <SecretField
            disabled={props.saving || !feishu.verificationToken.writable}
            label="Verification Token"
            sub="Stored in the system keychain. Used to verify event callbacks."
            secret="feishuVerificationToken"
            state={feishu.verificationToken}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <SecretField
            disabled={props.saving || !feishu.encryptKey.writable}
            label="Encryption Key"
            sub="Recommended. Stored in the system keychain. Used to decrypt encrypted persistent and webhook event payloads."
            secret="feishuEncryptKey"
            state={feishu.encryptKey}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <ToggleField
            checked={feishu.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses (Advanced)"
            sub="Sends partial assistant text as Feishu / Lark card edits."
            help={STREAMING_RESPONSES_WARNING}
            source={sourceBadge(feishu.streamingResponses)}
            onChange={(streamingResponses) => {
              void props.onSaveFeishu({
                ...feishu,
                streamingResponses: {
                  ...feishu.streamingResponses,
                  value: streamingResponses,
                },
              });
            }}
          />
          <ToggleField
            checked={feishu.registerSlashCommands.value}
            disabled={props.saving}
            label="Register slash commands"
            sub="Reserved for Feishu / Lark shortcut command setup. Mentions and DMs work without this."
            source={sourceBadge(feishu.registerSlashCommands)}
            onChange={(registerSlashCommands) => {
              void props.onSaveFeishu({
                ...feishu,
                registerSlashCommands: {
                  ...feishu.registerSlashCommands,
                  value: registerSlashCommands,
                },
              });
            }}
          />
          <TextField
            disabled={props.saving || !feishu.registerSlashCommands.value}
            label="Slash command prefix"
            sub="Prefix prepended to canonical commands (default pwragent_)."
            source={optionalStringSourceBadge(feishu.slashCommandPrefix)}
            value={feishu.slashCommandPrefix.value}
            onSave={(slashCommandPrefix) => {
              void props.onSaveFeishu({
                ...feishu,
                slashCommandPrefix: {
                  ...feishu.slashCommandPrefix,
                  value: slashCommandPrefix,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(props.desktopApi, "feishu", "user")}
            label="Authorized Open IDs"
            sub="Feishu / Lark open_id values that can DM or mention the bot."
            help="Open IDs usually start with ou_. Rejected messages show the open_id in Messaging Activity."
            source={optionalListSourceBadge(feishu.authorizedUserIds)}
            validateEntry={validateFeishuOpenIdEntry}
            value={feishu.authorizedUserIds.value}
            onSave={(authorizedUserIds) => {
              void props.onSaveFeishu({
                ...feishu,
                authorizedUserIds: {
                  ...feishu.authorizedUserIds,
                  value: authorizedUserIds,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(props.desktopApi, "feishu", "chat")}
            label="Authorized Chats"
            sub="Feishu / Lark chat IDs allowed for shared chat access."
            help="Chat IDs usually start with oc_. Empty shared-chat allowlists deny access."
            source={optionalListSourceBadge(feishu.authorizedChats)}
            validateEntry={validateFeishuChatIdEntry}
            value={feishu.authorizedChats.value}
            onSave={(authorizedChats) => {
              void props.onSaveFeishu({
                ...feishu,
                authorizedChats: {
                  ...feishu.authorizedChats,
                  value: authorizedChats,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(props.desktopApi, "feishu", "tenant")}
            label="Authorized Tenants"
            sub="Optional tenant keys allowed for shared chat access."
            help="Tenant keys are shown in Messaging Activity when Feishu / Lark includes them."
            source={optionalListSourceBadge(feishu.authorizedTenants)}
            validateEntry={validateFeishuTenantKeyEntry}
            value={feishu.authorizedTenants.value}
            onSave={(authorizedTenants) => {
              void props.onSaveFeishu({
                ...feishu,
                authorizedTenants: {
                  ...feishu.authorizedTenants,
                  value: authorizedTenants,
                },
              });
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Messaging"
        title="LINE"
        chip={chipLabelForBotToken(line.channelAccessToken)}
        chipKind={chipKindForBotToken(line.channelAccessToken)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={line.enabled.value}
            disabled={platformControlsDisabled}
            label="Enabled"
            sub="Turn the LINE adapter on or off independently of the global messaging switch."
            source={sourceBadge(line.enabled)}
            onChange={(enabled) => {
              void props.onSaveLine({
                ...line,
                enabled: { ...line.enabled, value: enabled },
              });
            }}
          />
          <SecretField
            disabled={props.saving || !line.channelAccessToken.writable}
            label="Channel Access Token"
            sub="Stored in the system keychain. Create or issue this from the LINE Developers console."
            secret="lineChannelAccessToken"
            state={line.channelAccessToken}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <SecretField
            disabled={props.saving || !line.channelSecret.writable}
            label="Channel Secret"
            sub="Stored in the system keychain. Used to verify X-Line-Signature before webhook processing."
            secret="lineChannelSecret"
            state={line.channelSecret}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <SettingsField
            label="Connection test"
            sub="Validates the channel access token with LINE getBotInfo."
            control={
              <SettingsTestBlock
                kind="line"
                desktopApi={props.desktopApi}
                icon={<LineIcon size={14} />}
                defaultName="Your LINE bot"
                defaultSub="getBotInfo"
              />
            }
          />
          <PairingTokenField
            desktopApi={props.desktopApi}
            disabled={platformControlsDisabled || !line.enabled.value}
            onSettingsChanged={props.onPairingSettingsChanged}
            platform="line"
            supportsBucket
          />
          <TextField
            disabled={props.saving}
            label="Webhook URL"
            sub="Public HTTPS URL configured in the LINE Developers console. This should point at your tunnel hostname."
            help={<code>https://line-webhook.example.com/</code>}
            placeholder="https://line-webhook.example.com/"
            source={optionalStringSourceBadge(line.webhookUrl)}
            value={line.webhookUrl.value}
            onSave={(webhookUrl) => {
              void props.onSaveLine({
                ...line,
                webhookUrl: { ...line.webhookUrl, value: webhookUrl },
              });
            }}
          />
          <TextField
            disabled={props.saving}
            label="Local Webhook Listener"
            sub="Where PwrAgent listens locally before the tunnel forwards LINE webhooks. The listener binds to the URL's host and port."
            help={<code>http://127.0.0.1:47822</code>}
            placeholder="http://127.0.0.1:47822"
            source={optionalStringSourceBadge(line.callbackBaseUrl)}
            value={line.callbackBaseUrl.value}
            onSave={(callbackBaseUrl) => {
              void props.onSaveLine({
                ...line,
                callbackBaseUrl: {
                  ...line.callbackBaseUrl,
                  value: callbackBaseUrl,
                },
              });
            }}
          />
          <TextField
            disabled={props.saving}
            label="Bot User ID"
            sub="Optional. Auto-discovered at startup and useful for group mention filtering."
            source={optionalStringSourceBadge(line.botUserId)}
            value={line.botUserId.value}
            onSave={(botUserId) => {
              void props.onSaveLine({
                ...line,
                botUserId: { ...line.botUserId, value: botUserId },
              });
            }}
          />
          <ToggleField
            checked={line.streamingResponses.value}
            disabled={props.saving}
            label="Streaming Responses (Advanced)"
            sub="LINE does not support message edits; leave this off so only final assistant text is posted."
            help={STREAMING_RESPONSES_WARNING}
            source={sourceBadge(line.streamingResponses)}
            onChange={(streamingResponses) => {
              void props.onSaveLine({
                ...line,
                streamingResponses: {
                  ...line.streamingResponses,
                  value: streamingResponses,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(props.desktopApi, "line", "user")}
            label="Authorized User IDs"
            sub="LINE user IDs that can DM or mention the bot."
            help="LINE user IDs use U followed by 32 lowercase hex characters."
            source={optionalListSourceBadge(line.authorizedUserIds)}
            validateEntry={validateLineUserIdEntry}
            value={line.authorizedUserIds.value}
            onSave={(authorizedUserIds) => {
              void props.onSaveLine({
                ...line,
                authorizedUserIds: {
                  ...line.authorizedUserIds,
                  value: authorizedUserIds,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(props.desktopApi, "line", "group")}
            label="Authorized Groups"
            sub="Optional LINE group IDs allowed for bound threads."
            help="LINE group IDs use C followed by 32 lowercase hex characters."
            source={optionalListSourceBadge(line.authorizedGroups)}
            validateEntry={validateLineGroupIdEntry}
            value={line.authorizedGroups.value}
            onSave={(authorizedGroups) => {
              void props.onSaveLine({
                ...line,
                authorizedGroups: {
                  ...line.authorizedGroups,
                  value: authorizedGroups,
                },
              });
            }}
          />
          <AuthorizedListField
            disabled={props.saving}
            lookup={contactLookup(props.desktopApi, "line", "room")}
            label="Authorized Rooms"
            sub="Optional LINE room IDs allowed for bound threads."
            help="LINE room IDs use R followed by 32 lowercase hex characters."
            source={optionalListSourceBadge(line.authorizedRooms)}
            validateEntry={validateLineRoomIdEntry}
            value={line.authorizedRooms.value}
            onSave={(authorizedRooms) => {
              void props.onSaveLine({
                ...line,
                authorizedRooms: {
                  ...line.authorizedRooms,
                  value: authorizedRooms,
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

const SLACK_INBOUND_MODE_OPTIONS: Array<{
  label: string;
  value: "socket" | "events";
}> = [
  { label: "Socket Mode", value: "socket" },
];

const FEISHU_TENANT_REGION_OPTIONS: Array<{
  label: string;
  value: "feishu" | "lark";
}> = [
  { label: "Feishu", value: "feishu" },
  { label: "Lark", value: "lark" },
];

const FEISHU_INBOUND_MODE_OPTIONS: Array<{
  label: string;
  value: "persistent" | "webhook";
}> = [
  { label: "Persistent", value: "persistent" },
  { label: "Webhook", value: "webhook" },
];

const STREAMING_RESPONSES_WARNING =
  "Advanced. Leave this off unless you specifically need live message edits. It does not make turns finish sooner; it repeatedly edits the same platform message, which can break voice readers and reach platform rate limits much sooner.";

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
  placeholder?: string;
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
          placeholder={props.placeholder}
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

function PairingTokenField(props: {
  desktopApi?: DesktopApi;
  disabled: boolean;
  onSettingsChanged?: () => Promise<void>;
  platform: MessagingChannelKind;
  scopeOptions?: PairingScopeOption[];
  supportsBucket?: boolean;
}) {
  const [scope, setScope] = useState<MessagingPairingScope>("user_dm");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [messageEntryId, setMessageEntryId] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<MessagingPairingEntry[]>([]);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = async () => {
    if (!props.desktopApi?.listMessagingPairingRequests) return;
    const result = await props.desktopApi.listMessagingPairingRequests({
      platform: props.platform,
    });
    setEntries(result.entries);
  };

  useEffect(() => {
    void refresh();
    return props.desktopApi?.onMessagingPairingChanged?.((event) => {
      if (event.entry.platform !== props.platform) return;
      if (event.entry.id === messageEntryId && event.entry.status !== "pending") {
        setMessage(undefined);
        setMessageEntryId(undefined);
      }
      void refresh();
    });
  }, [messageEntryId, props.desktopApi, props.platform]);

  const selectScope = (nextScope: MessagingPairingScope) => {
    setScope(nextScope);
    setMessage(undefined);
    setMessageEntryId(undefined);
  };

  const generate = async () => {
    if (!props.desktopApi?.generateMessagingPairingToken) return;
    setBusyId("generate");
    setError(undefined);
    try {
      const result = await props.desktopApi.generateMessagingPairingToken({
        platform: props.platform,
        scope,
      });
      setMessage(result.message);
      setMessageEntryId(result.entry.id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const decide = async (
    entry: MessagingPairingEntry,
    decision: "approve" | "reject",
  ) => {
    setBusyId(entry.id);
    setError(undefined);
    try {
      if (decision === "approve") {
        const result = await props.desktopApi?.approveMessagingPairing?.({
          entryId: entry.id,
        });
        if (result?.entry.id === messageEntryId) {
          setMessage(undefined);
          setMessageEntryId(undefined);
        }
        if (result?.added) {
          await props.onSettingsChanged?.();
        }
      } else {
        const result = await props.desktopApi?.rejectMessagingPairing?.({ entryId: entry.id });
        if (result?.entry.id === messageEntryId) {
          setMessage(undefined);
          setMessageEntryId(undefined);
        }
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const copyMessage = async () => {
    if (!message) return;
    setError(undefined);
    try {
      await copyText(message, props.desktopApi);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const observedEntries = entries.filter((entry) => entry.status === "observed");
  const scopeOptions = props.scopeOptions ?? defaultPairingScopeOptions(props.platform);
  const availableScopeOptions = props.supportsBucket
    ? scopeOptions
    : scopeOptions.filter((option) => option.value !== "bucket");

  return (
    <SettingsField
      label="Pairing"
      sub="Generate a short-lived code to approve a user or group from chat."
      error={error}
      control={
        <div className="settings-pairing">
          <div className="settings-pairing__controls">
            <div
              aria-label={`${platformLabel(props.platform)} pairing target`}
              className="settings-segmented settings-pairing__scope"
              role="radiogroup"
            >
              {availableScopeOptions.map((option) => (
                <button
                  key={option.value}
                  aria-checked={scope === option.value}
                  className={`settings-segmented__button${
                    scope === option.value ? " is-active" : ""
                  }`}
                  disabled={props.disabled}
                  role="radio"
                  type="button"
                  onClick={() => selectScope(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              className="button button--secondary"
              disabled={
                props.disabled
                || busyId === "generate"
                || !props.desktopApi?.generateMessagingPairingToken
              }
              type="button"
              onClick={() => void generate()}
            >
              {busyId === "generate" ? "Generating..." : "Generate"}
            </button>
          </div>
          {message ? (
            <div className="settings-pairing__message">
              <code>{message}</code>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => void copyMessage()}
              >
                Copy
              </button>
            </div>
          ) : null}
          {observedEntries.length > 0 ? (
            <div className="settings-pairing__requests">
              {observedEntries.map((entry) => (
                <div className="settings-pairing__request" key={entry.id}>
                  <div className="settings-pairing__request-text">
                    <span className="settings-pairing__request-title">
                      {pairingEntryLabel(entry)}
                    </span>
                    <span className="settings-pairing__request-meta">
                      {pairingEntryDetails(entry).join(" | ")}
                    </span>
                  </div>
                  <button
                    className="button button--secondary"
                    disabled={busyId === entry.id}
                    type="button"
                    onClick={() => void decide(entry, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    className="button button--ghost"
                    disabled={busyId === entry.id}
                    type="button"
                    onClick={() => void decide(entry, "reject")}
                  >
                    Reject
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

type PairingScopeOption = {
  label: string;
  value: MessagingPairingScope;
};

const TELEGRAM_PAIRING_SCOPE_OPTIONS: PairingScopeOption[] = [
  { label: "User via DM", value: "user_dm" },
  { label: "User via group", value: "user_in_group" },
  { label: "Group/supergroup chat", value: "bucket" },
];

function defaultPairingScopeOptions(platform: MessagingChannelKind): PairingScopeOption[] {
  if (platform === "discord") {
    return [
      { label: "User via DM", value: "user_dm" },
      { label: "User via server", value: "user_in_group" },
      { label: "Server", value: "bucket" },
    ];
  }
  if (platform === "slack") {
    return [
      { label: "User via DM", value: "user_dm" },
      { label: "User via channel", value: "user_in_group" },
      { label: "Workspace", value: "bucket" },
    ];
  }
  if (platform === "line") {
    return [
      { label: "User via DM", value: "user_dm" },
      { label: "User via group/room", value: "user_in_group" },
      { label: "Group/room", value: "bucket" },
    ];
  }
  return [
    { label: "User via DM", value: "user_dm" },
    { label: "User via channel", value: "user_in_group" },
    { label: "Group", value: "bucket" },
  ];
}

function platformLabel(platform: MessagingChannelKind): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function pairingEntryLabel(entry: MessagingPairingEntry): string {
  if (entry.scope === "bucket") {
    return `${entry.observedChat?.title ?? entry.observedChat?.id ?? "Chat"} wants group access`;
  }
  const actor =
    entry.observedActor?.displayName
    ?? entry.observedActor?.username
    ?? entry.observedActor?.id
    ?? "User";
  return `${actor} wants access`;
}

function pairingEntryDetails(entry: MessagingPairingEntry): string[] {
  const details: string[] = [];
  if (entry.observedActor?.id) {
    details.push(`User ID ${entry.observedActor.id}`);
  }
  if (entry.observedActor?.username) {
    details.push(`@${entry.observedActor.username}`);
  }
  if (entry.observedActor?.phoneNumber) {
    details.push(`Phone ${entry.observedActor.phoneNumber}`);
  }
  const chat = entry.observedChat;
  if (chat?.id) {
    if (entry.platform === "telegram" && chat.kind === "topic") {
      details.push(`Topic ID ${chat.id}`);
    } else {
      const chatLabel = chat.kind === "dm" ? "DM peer" : "Chat";
      details.push(`${chatLabel} ID ${chat.id}`);
    }
  }
  if (entry.observedChat?.title) {
    details.push(entry.observedChat.title);
  }
  if (chat?.bucketId && chat.bucketId !== chat.id) {
    const bucketLabel = entry.platform === "telegram" ? "Supergroup ID" : "Bucket ID";
    details.push(`${bucketLabel} ${chat.bucketId}`);
  }
  return details;
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
  const [rows, setRowsState] = useState<DesktopAuthorizedContact[]>(props.value);
  const rowsRef = useRef<DesktopAuthorizedContact[]>(props.value);
  const [lookupState, setLookupState] = useState<
    Record<number, { loading?: boolean; message?: string }>
  >({});
  useEffect(() => {
    rowsRef.current = props.value;
    setRowsState(props.value);
    setLookupState({});
  }, [props.value]);
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
  const setRows = (
    nextRowsOrUpdater: SetStateAction<DesktopAuthorizedContact[]>,
  ) => {
    const nextRows =
      typeof nextRowsOrUpdater === "function"
        ? nextRowsOrUpdater(rowsRef.current)
        : nextRowsOrUpdater;
    rowsRef.current = nextRows;
    setRowsState(nextRows);
  };

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
      const latestRows = rowsRef.current;
      const latestRow = normalizeAuthorizedContactRow(
        latestRows[indexToLookup] ?? { id: "", displayName: "" },
      );
      if (latestRow.id !== row.id) {
        setLookupState((current) => {
          const { [indexToLookup]: _discard, ...rest } = current;
          return rest;
        });
        return;
      }

      const nextRows = latestRows.map((current, rowIndex) =>
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
    displayName: sanitizeMessagingContactLabel(contact.displayName),
  };
}

function validateTelegramUserIdEntry(value: string): string | undefined {
  return validationMessage(
    validateTelegramPositiveId(value),
    "Telegram user ID",
    {
      format:
        value.startsWith("@") || /^[A-Za-z][A-Za-z0-9_]*$/.test(value)
          ? "That looks like a Telegram username, not a peer ID. Use the numeric form (e.g. 5550199999)."
          : "Use a positive numeric Telegram peer ID, e.g. 5550199999.",
      length: "Telegram peer IDs must fit the decimal numeric ID form.",
      range: "Use a positive Telegram peer ID, e.g. 5550199999.",
    },
  );
}

function validateTelegramGroupChatEntry(value: string): string | undefined {
  return validationMessage(
    validateTelegramGroupChatId(value),
    "Telegram group chat ID",
    {
      format:
        "Use the negative Telegram group or supergroup chat ID from Messaging Activity.",
      length: "Telegram group chat IDs must fit the decimal numeric ID form.",
      range:
        "Use the negative Telegram group or supergroup chat ID from Messaging Activity.",
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

function validateMattermostTeamIdEntry(value: string): string | undefined {
  return validationMessage(validateMattermostId(value), "Mattermost team ID", {
    format: "Use the 26-character lowercase a-z0-9 Mattermost team ID.",
    length: "Mattermost team IDs are exactly 26 lowercase a-z0-9 characters.",
  });
}

function validateMattermostConversationIdEntry(value: string): string | undefined {
  return validationMessage(validateMattermostId(value), "Mattermost conversation ID", {
    format: "Use the 26-character lowercase a-z0-9 Mattermost channel or group DM ID.",
    length: "Mattermost conversation IDs are exactly 26 lowercase a-z0-9 characters.",
  });
}

function validateSlackUserIdEntry(value: string): string | undefined {
  return validationMessage(validateSlackUserId(value), "Slack user ID", {
    format: "Use a Slack user ID starting with U or W, e.g. U012ABCDEF0.",
    length: "Slack user IDs must be 64 characters or fewer.",
  });
}

function validateSlackWorkspaceIdEntry(value: string): string | undefined {
  return validationMessage(validateSlackTeamId(value), "Slack workspace ID", {
    format: "Use a Slack workspace/team ID starting with T, e.g. T012ABCDEF0.",
    length: "Slack workspace IDs must be 64 characters or fewer.",
  });
}

function validateFeishuOpenIdEntry(value: string): string | undefined {
  return validationMessage(validateFeishuOpenId(value), "Feishu / Lark open ID", {
    format: "Use a Feishu / Lark open_id starting with ou_.",
    length: "Feishu / Lark open IDs must be 128 characters or fewer.",
  });
}

function validateFeishuChatIdEntry(value: string): string | undefined {
  return validationMessage(validateFeishuChatId(value), "Feishu / Lark chat ID", {
    format: "Use a Feishu / Lark chat_id starting with oc_.",
    length: "Feishu / Lark chat IDs must be 128 characters or fewer.",
  });
}

function validateFeishuTenantKeyEntry(value: string): string | undefined {
  return validationMessage(validateFeishuTenantKey(value), "Feishu / Lark tenant key", {
    format: "Use the tenant key shown in Messaging Activity.",
    length: "Feishu / Lark tenant keys must be 64 characters or fewer.",
  });
}

function validateLineUserIdEntry(value: string): string | undefined {
  return validationMessage(validateLineUserId(value), "LINE user ID", {
    format: "Use a LINE user ID starting with U followed by 32 lowercase hex characters.",
    length: "LINE user IDs are exactly 33 characters: U plus 32 lowercase hex characters.",
  });
}

function validateLineGroupIdEntry(value: string): string | undefined {
  return validationMessage(validateLineGroupId(value), "LINE group ID", {
    format: "Use a LINE group ID starting with C followed by 32 lowercase hex characters.",
    length: "LINE group IDs are exactly 33 characters: C plus 32 lowercase hex characters.",
  });
}

function validateLineRoomIdEntry(value: string): string | undefined {
  return validationMessage(validateLineRoomId(value), "LINE room ID", {
    format: "Use a LINE room ID starting with R followed by 32 lowercase hex characters.",
    length: "LINE room IDs are exactly 33 characters: R plus 32 lowercase hex characters.",
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
   * that fills the input with the produced value. Used by the Mattermost HMAC field
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
  const dirty = value.length > 0;
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
            Save
          </button>
          {dirty ? (
            <button
              className="button button--ghost"
              disabled={props.disabled}
              type="button"
              onClick={() => setValue("")}
            >
              Discard
            </button>
          ) : null}
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
