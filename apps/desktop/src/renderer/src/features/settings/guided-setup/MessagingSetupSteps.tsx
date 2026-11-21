import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
  SettingsCredentialTestKind,
  SettingsCredentialTestResult,
} from "@pwragent/shared/contracts/settings";
import type {
  MessagingChannelKind,
  MessagingPairingApprovalTarget,
  MessagingPairingScope,
} from "@pwragent/shared/contracts/messaging";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  SLACK_APPROVAL_TARGET_LABELS,
  slackApplicableApprovalTargets,
  slackApprovalSequence,
} from "../../../lib/slack-pairing-approval";
import { SlackConnectCard } from "../../messaging/SlackConnectCard";
import { SLACK_EVENTS_API_UNIMPLEMENTED_NOTICE } from "../../messaging/slack-connect-copy";
import { slackCredentialProblem } from "../../messaging/slack-token-shape";
import type { DesktopSettingsState } from "../useDesktopSettings";
import { SecretStatusLine, useSecretRemoveConfirm } from "../SecretStatusLine";
import { describeSecretField, secretStoreState } from "../secret-field-state";
import {
  DiscordIcon,
  FeishuIcon,
  LineIcon,
  MattermostIcon,
  SlackIcon,
  TelegramIcon,
} from "../../../icons";
import type { GuidedMessagingProvider } from "./messaging-setup-flow";

/*
 * Messaging steps for Settings' guided setup. Copied from first-run
 * onboarding and adapted for a profile that is already running: every
 * token is written to this profile's keychain the moment it is taken, so
 * the adapter starts and pairing works without a finish step.
 *
 * Nothing here renders until an acknowledgement is on record; the flow in
 * MessagingSetupFlow.tsx guarantees that through `visibleMessagingStep`.
 */

type ProviderRow = {
  id: GuidedMessagingProvider;
  name: string;
  icon: ReactNode;
  recommended?: boolean;
  notes: string;
  setupTime: string;
  risk: "low" | "med" | "high";
  riskLabel: string;
};

const PROVIDER_ROWS: readonly ProviderRow[] = [
  {
    id: "telegram",
    name: "Telegram",
    icon: <TelegramIcon size={20} aria-hidden />,
    recommended: true,
    notes:
      "Sign up on mobile · BotFather /newbot · paste token · pairing code · go. No ports, no tunnels.",
    setupTime: "~2 min",
    risk: "low",
    riskLabel: "Lowest",
  },
  {
    id: "discord",
    name: "Discord",
    icon: <DiscordIcon size={20} aria-hidden />,
    notes:
      "Developer Portal app · bot token · OAuth invite to a server. No ports or tunnels needed.",
    setupTime: "~10 min",
    risk: "low",
    riskLabel: "Low",
  },
  {
    id: "mattermost",
    name: "Mattermost",
    icon: <MattermostIcon size={20} aria-hidden />,
    notes:
      "Self-hosted: easy. Callback URL needed — private network low, public higher.",
    setupTime: "~15 min",
    risk: "med",
    riskLabel: "Medium",
  },
  {
    id: "feishu",
    name: "Feishu / Lark",
    icon: <FeishuIcon size={20} aria-hidden />,
    notes:
      "Open Platform app · app secret · webhook may apply depending on region.",
    setupTime: "~20 min",
    risk: "med",
    riskLabel: "Low–medium",
  },
  {
    id: "slack",
    name: "Slack",
    icon: <SlackIcon size={20} aria-hidden />,
    notes:
      "Create from PwrAgent's Slack manifest · Install to Workspace · paste xoxb- and xapp-.",
    setupTime: "~10 min",
    risk: "med",
    riskLabel: "Low–medium",
  },
  {
    id: "line",
    name: "LINE",
    icon: <LineIcon size={20} aria-hidden />,
    notes:
      "Webhook-only inbound. Requires public HTTPS URL (tunnel needed for self-hosted).",
    setupTime: "~25 min + tunnel",
    risk: "high",
    riskLabel: "Medium-high",
  },
];

export function MessagingProvidersStep(props: {
  selected: readonly GuidedMessagingProvider[];
  onToggle: (id: GuidedMessagingProvider) => void;
}) {
  const picked = new Set(props.selected);
  const toggle = props.onToggle;
  return (
    <div>
      <header className="guided-setup__head">
        <h1 className="guided-setup__title">
          Pick the messaging platforms you want to connect
        </h1>
        <p className="guided-setup__sub">
          Ranked by setup time and risk profile. Telegram is preselected —
          it&rsquo;s the lowest-friction path. You&rsquo;ll set up each one
          here, one at a time, and can add more later.
        </p>
      </header>
      <div className="guided-setup__provider-table" role="grid">
        <div className="guided-setup__provider-row is-head" role="row">
          <span />
          <span>Provider</span>
          <span>Notes</span>
          <span>Setup time</span>
          <span>Risk profile</span>
        </div>
        {PROVIDER_ROWS.map((row) => {
          const checked = picked.has(row.id);
          return (
            <label
              key={row.id}
              className={`guided-setup__provider-row${checked ? " is-checked" : ""}`}
              role="row"
            >
              <span className="guided-setup__provider-check-cell">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(row.id)}
                  className="guided-setup__visually-hidden"
                />
                <span
                  className={`guided-setup__provider-check${checked ? " is-on" : ""}`}
                  aria-hidden
                />
              </span>
              <span className="guided-setup__provider-name">
                <span className="guided-setup__provider-icon">{row.icon}</span>
                {row.name}
                {row.recommended ? (
                  <span className="guided-setup__provider-rec">
                    Recommended
                  </span>
                ) : null}
              </span>
              <span className="guided-setup__provider-notes">
                {row.notes}
              </span>
              <span className="guided-setup__provider-meta">
                {row.setupTime}
              </span>
              <span
                className={`guided-setup__provider-risk guided-setup__provider-risk--${row.risk}`}
              >
                <span className="guided-setup__provider-risk-dot" />
                {row.riskLabel}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Step: Per-provider inline setup (Step 3c — one per selected provider)
   ---------------------------------------------------------------- */

type ProviderField =
  | {
      kind: "secret";
      name: DesktopSettingsSecretName;
      label: string;
      sub?: string;
      /** Rejects a value before it is buffered or written; see `SecretFieldRow`. */
      validate?: (value: string) => string | undefined;
    }
  | {
      kind: "text";
      key: string;
      label: string;
      sub?: string;
      placeholder?: string;
    }
  | {
      kind: "segmented";
      key: string;
      label: string;
      sub?: string;
      options: ReadonlyArray<{ label: string; value: string }>;
    };

type ProviderPairingOption = {
  scope: MessagingPairingScope;
  label: string;
  help?: ReactNode;
};

type ProviderSetupConfig = {
  id: GuidedMessagingProvider;
  intro: ReactNode;
  fields: readonly ProviderField[];
  /** Section title shown above the pairing block. Frame it from the
   *  operator's perspective ("Pair your DMs"), not the app's ("Pair
   *  this device") — PwrAgent isn't the device the operator pairs FROM. */
  pairingTitle?: string;
  pairingOptions?: readonly ProviderPairingOption[];
};

const PROVIDER_SETUP_CONFIGS: Record<GuidedMessagingProvider, ProviderSetupConfig> = {
  telegram: {
    id: "telegram",
    intro: (
      <>
        Message <strong>@BotFather</strong> on Telegram, send <code>/newbot</code>,
        pick a name. BotFather replies with a bot token — paste it below.
      </>
    ),
    fields: [
      {
        kind: "secret",
        name: "telegramBotToken",
        label: "Bot token",
        sub: "From @BotFather. It looks like 0000000000:AAEx…",
      },
    ],
    pairingTitle: "Pair a Telegram conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs",
        help: (
          <>
            From <strong>your</strong> Telegram account, open the chat with
            your new bot and send the pairing message below. PwrAgent sees the
            message land and finishes pairing automatically — you can use
            Telegram on any device, the pairing is between your account and
            the bot.
          </>
        ),
      },
      {
        scope: "bucket",
        label: "Pair a Supergroup / Forum (just you + the bot)",
        help: (
          <>
            <p>
              Add the bot to a supergroup or forum that contains only you and
              it, then send the pairing message inside any topic. Threads will
              land in that topic. Best for keeping the bot conversation in its
              own room separate from your DMs.
            </p>
            <p className="guided-setup__pairing-warning">
              <strong>⚠ Telegram bot privacy:</strong> by default BotFather
              ships new bots with <em>privacy mode on</em>, which means the
              bot can&rsquo;t see plain messages in groups — only commands,
              @mentions, and replies. If your pairing message never gets a
              reply from the bot, you need to do <strong>one</strong> of:
            </p>
            <ul className="guided-setup__pairing-warning-list">
              <li>
                <strong>@mention the bot</strong> in your pair message — e.g.{" "}
                <code>@yourbot pair &lt;token&gt;</code>. You&rsquo;ll need to
                @mention it on every message you want the bot to see.
              </li>
              <li>
                <strong>Make the bot an admin</strong> in the group. Admins
                always see all messages regardless of privacy mode.
              </li>
              <li>
                <strong>Turn privacy mode off</strong> in BotFather:{" "}
                <code>/mybots</code> → pick your bot → Bot Settings → Group
                Privacy → Turn off. The bot then sees every message in groups
                it&rsquo;s a member of.
              </li>
            </ul>
          </>
        ),
      },
    ],
  },
  discord: {
    id: "discord",
    intro: (
      <>
        Discord Developer Portal → create an Application → Bot tab → reset
        token. Paste it below along with the Application ID (General
        Information tab).
      </>
    ),
    fields: [
      {
        kind: "secret",
        name: "discordBotToken",
        label: "Bot token",
        sub: "Bot → Reset Token.",
      },
      {
        kind: "text",
        key: "applicationId",
        label: "Application ID",
        sub: "Found under General Information → Application ID.",
        placeholder: "1480556454498009352",
      },
    ],
    pairingTitle: "Pair a Discord conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            Invite the bot to a server (Developer Portal → OAuth2 URL
            Generator, scopes <code>bot</code> + <code>applications.commands</code>),
            then DM the bot the pairing message below from your Discord
            account.
          </>
        ),
      },
    ],
  },
  mattermost: {
    id: "mattermost",
    intro: (
      <>
        In your Mattermost server: System Console → Integrations → Bot
        Accounts → create a bot, copy the token. Also set the server URL and
        a callback base URL reachable from the Mattermost host.
      </>
    ),
    fields: [
      {
        kind: "text",
        key: "serverUrl",
        label: "Server URL",
        placeholder: "https://chat.example.com",
      },
      {
        kind: "secret",
        name: "mattermostBotToken",
        label: "Bot token",
      },
      {
        kind: "secret",
        name: "mattermostHmacSecret",
        label: "HMAC signing secret",
        sub: "Verifies incoming webhook callbacks. Generate any high-entropy string.",
      },
      {
        kind: "text",
        key: "callbackBaseUrl",
        label: "Callback base URL",
        sub: "Public URL Mattermost will POST events to (tunnel or LAN).",
        placeholder: "https://pwragent.tail.example.ts.net",
      },
    ],
    pairingTitle: "Pair a Mattermost conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            From your Mattermost account, open a direct message with the bot
            and post the pairing message below.
          </>
        ),
      },
    ],
  },
  feishu: {
    id: "feishu",
    intro: (
      <>
        Feishu / Lark Open Platform → create a custom app → copy App ID,
        App Secret, Encrypt Key, and Verification Token. Pick which tenant
        region to use and the inbound mode.
      </>
    ),
    fields: [
      {
        kind: "segmented",
        key: "tenantRegion",
        label: "Tenant region",
        options: [
          { label: "Lark (international)", value: "lark" },
          { label: "Feishu (China)", value: "feishu" },
        ],
      },
      {
        kind: "segmented",
        key: "inboundMode",
        label: "Inbound mode",
        sub: "Persistent uses long-polling; Webhook needs a public callback URL.",
        options: [
          { label: "Persistent", value: "persistent" },
          { label: "Webhook", value: "webhook" },
        ],
      },
      { kind: "secret", name: "feishuAppId", label: "App ID" },
      { kind: "secret", name: "feishuAppSecret", label: "App secret" },
      { kind: "secret", name: "feishuEncryptKey", label: "Encrypt key" },
      {
        kind: "secret",
        name: "feishuVerificationToken",
        label: "Verification token",
      },
    ],
    pairingTitle: "Pair a Feishu / Lark conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            Open a 1:1 chat with the bot inside Feishu / Lark and post the
            pairing message below.
          </>
        ),
      },
    ],
  },
  slack: {
    id: "slack",
    intro: (
      <>
        Create a customer-owned Slack app from PwrAgent&rsquo;s official
        manifest, install it to your workspace, then paste the bot token
        (<code>xoxb-</code>), the app-level token (<code>xapp-</code>), and the
        signing secret. Socket Mode is the only inbound path.
      </>
    ),
    // Each box saves when focus leaves it, and rejects a value that is
    // recognizably one of the other two.
    fields: [
      {
        kind: "secret",
        name: "slackBotToken",
        label: "Bot token (xoxb-…)",
        sub: "Install App → OAuth Tokens → Bot User OAuth Token.",
        validate: (value) => slackCredentialProblem("bot", value),
      },
      {
        kind: "secret",
        name: "slackAppToken",
        label: "App-level token (xapp-…)",
        sub: "Required for Socket Mode. Basic Information → App-Level Tokens → Generate Token and Scopes, with only connections:write.",
        validate: (value) => slackCredentialProblem("app", value),
      },
      {
        kind: "secret",
        name: "slackSigningSecret",
        label: "Signing secret",
        sub: "Basic Information → App Credentials. Signs the buttons PwrAgent posts.",
        validate: (value) => slackCredentialProblem("signing", value),
      },
    ],
    pairingTitle: "Pair a Slack conversation",
    pairingOptions: [
      {
        scope: "observed",
        label: "Pair from Slack",
        help: (
          <>
            Send the pairing message in a Slack DM or channel. PwrAgent will
            show what it saw so you can approve the user or the channel.
          </>
        ),
      },
    ],
  },
  line: {
    id: "line",
    intro: (
      <>
        LINE Developers → Messaging API channel → copy the Channel Access
        Token and Channel Secret. LINE is webhook-only inbound, so you need a
        public HTTPS URL pointing at this machine (Cloudflare Tunnel, Tailscale
        Funnel, ngrok, etc.).
      </>
    ),
    fields: [
      {
        kind: "secret",
        name: "lineChannelAccessToken",
        label: "Channel access token",
      },
      { kind: "secret", name: "lineChannelSecret", label: "Channel secret" },
      {
        kind: "text",
        key: "botUserId",
        label: "Bot user ID",
        sub: "Found under Messaging API tab — starts with U.",
        placeholder: "U1234567890abcdef…",
      },
      {
        kind: "text",
        key: "callbackBaseUrl",
        label: "Public callback URL",
        sub: "Must be reachable over HTTPS from LINE's servers.",
        placeholder: "https://pwragent.tail.example.ts.net",
      },
    ],
    pairingTitle: "Pair a LINE conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            From your LINE account, add the bot as a friend and post the
            pairing message in the 1:1 chat.
          </>
        ),
      },
    ],
  },
};

export function ProviderSetupStep(props: {
  provider: GuidedMessagingProvider;
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
}) {
  const config = PROVIDER_SETUP_CONFIGS[props.provider];
  const snapshot = props.settings.snapshot;
  const platformSnapshot = snapshot?.messaging?.[props.provider];

  // Auto-enable the platform when the step opens so pairing / probe work.
  useEffect(() => {
    if (!platformSnapshot) return;
    if (platformSnapshot.enabled.value) return;
    void props.settings.writeConfig({
      messaging: { [props.provider]: { enabled: true } } as never,
    });
    // intentionally only run when provider changes — repeated writes would
    // race with the snapshot refresh fired by writeConfig itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.provider]);

  useEffect(() => {
    if (props.provider !== "slack") return;
    if (snapshot?.messaging.slack.inboundMode.value !== "events") return;
    void props.settings.writeConfig({
      messaging: { slack: { inboundMode: "socket" } },
    });
    // Coerce leftover Events API configs once when the Slack step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.provider]);

  const leftoverEventsInbound =
    props.provider === "slack"
    && snapshot?.messaging.slack.inboundMode.value === "events";

  return (
    <div className="guided-setup__provider-setup">
      <header className="guided-setup__head">
        <h1 className="guided-setup__title">
          <span className="guided-setup__provider-setup-icon">
            {providerIcon(props.provider, 22)}
          </span>
          Connect {providerName(props.provider)}
        </h1>
        <p className="guided-setup__sub">{config.intro}</p>
      </header>
      {snapshot && !snapshot.messaging.enabled.value ? (
        <div className="guided-setup__notice guided-setup__notice--action" role="status">
          <span>
            Messaging is off for this profile, so the bot can&rsquo;t see the
            pairing message yet.
          </span>
          <button
            type="button"
            className="guided-setup__btn guided-setup__btn--ghost"
            disabled={props.settings.saving}
            onClick={() => {
              void props.settings.writeConfig({ messaging: { enabled: true } });
            }}
          >
            Turn on messaging
          </button>
        </div>
      ) : null}
      {props.provider === "slack" ? (
        <SlackConnectCard
          appName={snapshot?.messaging.slack.appName}
          desktopApi={props.desktopApi}
          saving={props.settings.saving}
          variant="onboarding"
          onSaveAppName={async (appName) => {
            const saved = await props.settings.writeConfig({
              messaging: { slack: { appName } },
            });
            if (!saved) throw new Error("Could not save the agent name.");
          }}
        />
      ) : null}
      {leftoverEventsInbound ? (
        <p className="guided-setup__notice" role="status">
          {SLACK_EVENTS_API_UNIMPLEMENTED_NOTICE}
        </p>
      ) : null}
      <div className="guided-setup__provider-fields">
        {config.fields.map((field) => (
          <ProviderFieldRow
            key={field.kind === "secret" ? `secret:${field.name}` : `text:${field.key}`}
            field={field}
            provider={props.provider}
            snapshot={snapshot}
            saving={props.settings.saving}
            writeConfig={props.settings.writeConfig}
            replaceSecret={props.settings.replaceSecret}
            clearSecret={props.settings.clearSecret}
          />
        ))}
      </div>
      {props.provider === "slack" ? (
        <details className="guided-setup__advanced">
          <summary>Advanced — optional fields</summary>
          <div className="guided-setup__provider-fields">
            <ProviderFieldRow
              field={{
                kind: "text",
                key: "workspaceUrl",
                label: "Workspace URL",
                placeholder: "https://your-team.slack.com",
              }}
              provider={props.provider}
              snapshot={snapshot}
              saving={props.settings.saving}
              writeConfig={props.settings.writeConfig}
              replaceSecret={props.settings.replaceSecret}
              clearSecret={props.settings.clearSecret}
            />
          </div>
        </details>
      ) : null}
      <ProviderIdentityProbe
        provider={props.provider}
        snapshot={snapshot}
        desktopApi={props.desktopApi}
      />
      {config.pairingOptions && config.pairingOptions.length > 0 ? (
        <PairingBlock
          platform={props.provider}
          title={config.pairingTitle ?? "Pair a conversation"}
          options={config.pairingOptions}
          desktopApi={props.desktopApi}
        />
      ) : null}
    </div>
  );
}

function ProviderFieldRow(props: {
  field: ProviderField;
  provider: GuidedMessagingProvider;
  snapshot?: DesktopSettingsSnapshot;
  saving: boolean;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  replaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  clearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
}) {
  if (props.field.kind === "secret") {
    return (
      <SecretFieldRow
        field={props.field}
        snapshot={props.snapshot}
        replaceSecret={props.replaceSecret}
        clearSecret={props.clearSecret}
      />
    );
  }
  if (props.field.kind === "text") {
    return (
      <TextFieldRow
        field={props.field}
        provider={props.provider}
        snapshot={props.snapshot}
        saving={props.saving}
        writeConfig={props.writeConfig}
      />
    );
  }
  return (
    <SegmentedFieldRow
      field={props.field}
      provider={props.provider}
      snapshot={props.snapshot}
      saving={props.saving}
      writeConfig={props.writeConfig}
    />
  );
}

/**
 * Probe the provider's credentials and surface the bot identity
 * inline (e.g. "Connected as @pwragent_bot · api.telegram.org") so
 * the operator immediately sees the token landed on the right bot
 * account. Mirrors the Settings → Messaging "test connection"
 * affordance, but runs *automatically* once the underlying secret
 * is configured — the wizard's step is already a setup moment, so
 * the operator shouldn't need a separate Test click.
 *
 * Probe trigger: re-runs whenever the snapshot's primary-secret
 * `configured` flips from false → true, or the snapshot's
 * fetchedAt advances after a live secret replace. Failure surfaces
 * a short error line; the snapshot's "✓ saved" pill on the field
 * row still indicates the token *was* persisted.
 */
function ProviderIdentityProbe(props: {
  provider: GuidedMessagingProvider;
  snapshot?: DesktopSettingsSnapshot;
  desktopApi?: DesktopApi;
}) {
  const [result, setResult] = useState<SettingsCredentialTestResult | undefined>(
    undefined,
  );
  const [running, setRunning] = useState(false);
  const configured = isPlatformPrimarySecretConfigured(props.provider, props.snapshot);
  const desktopApi = props.desktopApi;
  const probeKind: SettingsCredentialTestKind = props.provider;
  const fetchedAt = props.snapshot?.fetchedAt;

  useEffect(() => {
    if (!configured || !desktopApi?.testSettingsCredentials) {
      // Nothing to probe — clear stale result when the secret is
      // unconfigured (e.g. operator pressed Clear).
      setResult(undefined);
      return;
    }
    let cancelled = false;
    setRunning(true);
    void desktopApi
      .testSettingsCredentials({ kind: probeKind })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setResult({
          kind: probeKind,
          status: "failed",
          testedAt: Date.now(),
          durationMs: 0,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!cancelled) setRunning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configured, desktopApi, fetchedAt, probeKind]);

  if (!configured && !running && !result) return null;

  const status = running ? "testing" : (result?.status ?? "idle");
  return (
    <div
      className="guided-setup__provider-identity"
      data-status={status}
      aria-live="polite"
    >
      {running ? (
        <span className="guided-setup__provider-identity-text">
          Checking the bot account…
        </span>
      ) : result?.status === "ok" ? (
        <span className="guided-setup__provider-identity-text">
          <span className="guided-setup__provider-identity-pill is-ok">
            ✓ Connected
          </span>
          {result.account ? (
            <strong className="guided-setup__provider-identity-account">
              {result.account}
            </strong>
          ) : null}
          {result.detail ? (
            <span className="guided-setup__provider-identity-detail">
              {result.detail}
            </span>
          ) : null}
        </span>
      ) : result?.status === "failed" ? (
        <span className="guided-setup__provider-identity-text">
          <span className="guided-setup__provider-identity-pill is-err">
            ✕ Could not reach the bot
          </span>
          {result.errorMessage ? (
            <span className="guided-setup__provider-identity-detail">
              {result.errorMessage}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Read the configured state of a platform's *primary* identity-bearing
 * secret. Used by `ProviderIdentityProbe` to know when to run the
 * `testSettingsCredentials` probe. Each platform's identity-revealing
 * probe needs its own primary secret to be set — Telegram needs the
 * bot token, Slack needs both bot + signing secret, etc. We pick the
 * single most-load-bearing one per platform and call that the trigger.
 *
 * (We don't try to gate on EVERY secret being present — that would
 * silently hide the probe for multi-field providers like Slack until
 * both tokens are entered. Slack waits for xoxb- + xapp- because the
 * probe now reports bot identity and Socket Mode separately.)
 */
function isPlatformPrimarySecretConfigured(
  provider: GuidedMessagingProvider,
  snapshot?: DesktopSettingsSnapshot,
): boolean {
  if (!snapshot) return false;
  switch (provider) {
    case "telegram":
      return snapshot.messaging?.telegram?.botToken?.configured === true;
    case "discord":
      return snapshot.messaging?.discord?.botToken?.configured === true;
    case "mattermost":
      return snapshot.messaging?.mattermost?.botToken?.configured === true;
    case "slack":
      return snapshot.messaging?.slack?.botToken?.configured === true
        && snapshot.messaging?.slack?.appToken?.configured === true;
    case "feishu":
      return snapshot.messaging?.feishu?.appSecret?.configured === true;
    case "line":
      return snapshot.messaging?.line?.channelAccessToken?.configured === true;
  }
}

/**
 * One secret field. A value is written to this profile's keychain when it
 * is taken (Enter, the button, or leaving the row), so the adapter starts
 * and the pairing step can see messages without any finish step. The value
 * never leaves the input's own state otherwise: it is not buffered, logged,
 * or echoed back.
 */
export function SecretFieldRow(props: {
  field: Extract<ProviderField, { kind: "secret" }>;
  snapshot?: DesktopSettingsSnapshot;
  replaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  clearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | undefined>(undefined);
  // This row's own write succeeded. The snapshot catches up a moment later.
  const [wrote, setWrote] = useState(false);
  const statusId = useId();
  const state = readSecretState(props.snapshot, props.field.name);
  const configured = state?.configured ?? false;
  // A value removed elsewhere stops this row's write from vouching for it.
  const [wasConfigured, setWasConfigured] = useState(configured);
  if (wasConfigured !== configured) {
    setWasConfigured(configured);
    if (!configured) setWrote(false);
  }
  const dirty = value.trim().length > 0;
  const removable = (configured || wrote) && state?.source !== "env";
  const removal = useSecretRemoveConfirm(removable);
  const view = describeSecretField(state ?? secretStoreState(false), {
    dirty,
    saved: wrote,
    held: false,
    confirmingRemove: removal.confirming,
  });
  const confirming = removal.confirming && removable && !dirty;
  const save = async (): Promise<void> => {
    // What is checked is what is stored: a copy often brings a newline.
    const nextValue = value.trim();
    if (!nextValue || busy) return;
    const problem = props.field.validate?.(nextValue);
    setLiveError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const ok = await props.replaceSecret(props.field.name, nextValue);
      setWrote(ok);
      if (!ok) {
        setLiveError("Could not save this value — try again.");
        return;
      }
    } finally {
      setBusy(false);
    }
    setValue("");
  };
  const clear = async (): Promise<void> => {
    if (busy) return;
    setWrote(false);
    setBusy(true);
    setLiveError(undefined);
    try {
      await props.clearSecret(props.field.name);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="guided-setup__field">
      <div className="guided-setup__field-head">
        <span className="guided-setup__field-label">{props.field.label}</span>
      </div>
      {props.field.sub ? (
        <span className="guided-setup__field-sub">{props.field.sub}</span>
      ) : null}
      <div
        // Wraps so the status line takes its own line under the input.
        className="guided-setup__field-row settings-secret--status"
        onBlur={(event) => {
          // Leaving the row keeps what was pasted. Focus moving to this
          // row's own buttons is not leaving it.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          void save();
        }}
      >
        <input
          aria-describedby={statusId}
          aria-label={props.field.label}
          type="password"
          autoComplete="off"
          className="guided-setup__input"
          placeholder={view.placeholder}
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            removal.cancel();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
        {confirming ? null : (
          <button
            type="button"
            className="guided-setup__btn guided-setup__btn--ghost"
            disabled={!value || busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : view.commitLabel}
          </button>
        )}
        {dirty ? null : confirming ? (
          <>
            <button
              aria-label={`Remove saved ${props.field.label} now`}
              type="button"
              className="guided-setup__btn guided-setup__btn--ghost"
              disabled={busy}
              onClick={() => {
                removal.cancel();
                void clear();
              }}
            >
              Remove
            </button>
            <button
              ref={removal.keepRef}
              aria-label={`Keep saved ${props.field.label}`}
              type="button"
              className="guided-setup__btn guided-setup__btn--link"
              disabled={busy}
              onClick={removal.keep}
            >
              Keep
            </button>
          </>
        ) : removable ? (
          <button
            ref={removal.removeRef}
            aria-label={`Remove saved ${props.field.label}`}
            type="button"
            className="guided-setup__btn guided-setup__btn--link"
            disabled={busy}
            onClick={removal.ask}
          >
            Remove
          </button>
        ) : null}
        <SecretStatusLine announce={confirming} id={statusId} pending={busy} view={view} />
      </div>
      {liveError ? (
        <span className="guided-setup__field-error">{liveError}</span>
      ) : null}
    </div>
  );
}

function TextFieldRow(props: {
  field: Extract<ProviderField, { kind: "text" }>;
  provider: GuidedMessagingProvider;
  snapshot?: DesktopSettingsSnapshot;
  saving: boolean;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const stored =
    (readPlatformValue(props.snapshot, props.provider, props.field.key) as
      | string
      | undefined) ?? "";
  const [value, setValue] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const dirty = value !== stored;
  // Resync when stored value changes (e.g. snapshot refresh).
  useEffect(() => {
    setValue(stored);
  }, [stored]);
  const save = async (): Promise<void> => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(undefined);
    const patch = buildPlatformPatch(props.provider, props.field.key, value);
    const ok = await props.writeConfig(patch);
    if (!ok) setError("Could not save.");
    setBusy(false);
  };
  return (
    <div className="guided-setup__field">
      <div className="guided-setup__field-head">
        <span className="guided-setup__field-label">{props.field.label}</span>
        <span className="guided-setup__field-status">
          {stored ? (
            <span className="guided-setup__field-pill is-ok">✓ saved</span>
          ) : (
            <span className="guided-setup__field-pill">not set</span>
          )}
        </span>
      </div>
      {props.field.sub ? (
        <span className="guided-setup__field-sub">{props.field.sub}</span>
      ) : null}
      <div className="guided-setup__field-row">
        <input
          type="text"
          className="guided-setup__input"
          placeholder={props.field.placeholder}
          value={value}
          disabled={props.saving || busy}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
        {dirty ? (
          <button
            type="button"
            className="guided-setup__btn guided-setup__btn--ghost"
            disabled={busy || props.saving}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
      {error ? (
        <span className="guided-setup__field-error">{error}</span>
      ) : null}
    </div>
  );
}

function SegmentedFieldRow(props: {
  field: Extract<ProviderField, { kind: "segmented" }>;
  provider: GuidedMessagingProvider;
  snapshot?: DesktopSettingsSnapshot;
  saving: boolean;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const stored =
    (readPlatformValue(props.snapshot, props.provider, props.field.key) as
      | string
      | undefined) ?? props.field.options[0]?.value;
  const select = async (value: string): Promise<void> => {
    if (value === stored) return;
    const patch = buildPlatformPatch(props.provider, props.field.key, value);
    await props.writeConfig(patch);
  };
  return (
    <div className="guided-setup__field">
      <div className="guided-setup__field-head">
        <span className="guided-setup__field-label">{props.field.label}</span>
      </div>
      {props.field.sub ? (
        <span className="guided-setup__field-sub">{props.field.sub}</span>
      ) : null}
      <div className="guided-setup__segmented">
        {props.field.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`guided-setup__segmented-btn${stored === option.value ? " is-active" : ""}`}
            disabled={props.saving}
            onClick={() => void select(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Pairing-token block — reuses generateMessagingPairingToken IPC
   and watches onMessagingPairingChanged for live status updates
   ---------------------------------------------------------------- */

/**
 * A pairing the operator approved during *this* wizard session.
 * Used to render a compact "you paired X, Y, Z" summary after the
 * pairing flow completes, so the operator can see what they've
 * authorized without leaving the step. Multiple entries accumulate
 * when the operator clicks "Pair another" — Telegram in particular
 * commonly wants both a DM pairing and one or more supergroup
 * pairings on the same bot.
 *
 * `actor`/`chat` are display labels resolved from the
 * pairing-changed event's `observedActor` / `observedChat` (handle
 * / displayName falling back to id). Kept as plain strings here
 * because this list is purely cosmetic — the authoritative source
 * is the per-platform `authorizedUserIds` / `authorizedSupergroups`
 * snapshot, which the new spawned profile's main window will
 * pick up after graduation.
 */
type SessionPairing = {
  entryId: string;
  scope: MessagingPairingScope;
  actor?: string;
  chat?: string;
};

function PairingBlock(props: {
  platform: MessagingChannelKind;
  title: string;
  options: readonly ProviderPairingOption[];
  desktopApi?: DesktopApi;
}) {
  const [scope, setScope] = useState<MessagingPairingScope>(
    props.options[0]?.scope ?? "user_dm",
  );
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [entryId, setEntryId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );
  const [resolution, setResolution] = useState<"observed" | "approved" | undefined>(
    undefined,
  );
  // Captured display info for the observed actor/chat — used to render
  // the inline "Approve @huntharo …" affordance and to seed the
  // session pairing list on approval.
  const [observedActorLabel, setObservedActorLabel] = useState<string | undefined>(
    undefined,
  );
  const [observedChatLabel, setObservedChatLabel] = useState<string | undefined>(
    undefined,
  );
  const [observedChatKind, setObservedChatKind] = useState<string | undefined>(
    undefined,
  );
  const [observedChatBucketId, setObservedChatBucketId] = useState<
    string | undefined
  >(undefined);
  const [approvedTargets, setApprovedTargets] = useState<
    MessagingPairingApprovalTarget[]
  >([]);
  const [approving, setApproving] = useState(false);
  // Pairings approved during this wizard session, in order. Rendered
  // as a compact summary once at least one pairing has been approved.
  // Survives the "Pair another" reset (which only clears the *current*
  // in-flight token, not the running list).
  const [paired, setPaired] = useState<readonly SessionPairing[]>([]);
  // Set by "+ Pair another" — re-arms the active flow (Generate code
  // button, scope picker) without clearing the `paired` summary above.
  // Cleared on approval so the next approval falls back into compact
  // mode unless the operator re-clicks "Pair another".
  const [pairingAnother, setPairingAnother] = useState(false);
  const entryIdRef = useRef<string | undefined>(undefined);
  entryIdRef.current = entryId;

  const activeOption = props.options.find((o) => o.scope === scope) ?? props.options[0];

  useEffect(() => {
    if (!props.desktopApi?.onMessagingPairingChanged) return;
    return props.desktopApi.onMessagingPairingChanged((event) => {
      if (event.entry.platform !== props.platform) return;
      if (event.entry.id !== entryIdRef.current) return;
      if (event.entry.status === "observed" || event.entry.status === "approved") {
        setResolution(event.entry.status);
        setObservedActorLabel(
          event.entry.observedActor?.displayName
            ?? event.entry.observedActor?.id,
        );
        setObservedChatLabel(
          event.entry.observedChat?.title ?? event.entry.observedChat?.id,
        );
        setObservedChatKind(event.entry.observedChat?.kind);
        setObservedChatBucketId(event.entry.observedChat?.bucketId);
        setApprovedTargets(event.entry.approvedTargets ?? []);
      }
    });
  }, [props.desktopApi, props.platform]);

  // Move the just-resolved pairing into the compact "paired" summary and
  // clear the active pairing-token surface. The "Pair another" button
  // (rendered when `paired.length > 0`) re-arms the flow.
  const finalizePaired = (id: string): void => {
    setPaired((prev) => [
      ...prev,
      {
        entryId: id,
        scope,
        actor: observedActorLabel,
        chat: observedChatLabel,
      },
    ]);
    setMessage(undefined);
    setEntryId(undefined);
    setObservedActorLabel(undefined);
    setObservedChatLabel(undefined);
    setObservedChatKind(undefined);
    setObservedChatBucketId(undefined);
    setApprovedTargets([]);
    setResolution(undefined);
    setPairingAnother(false);
  };

  // Generic single-shot approve for non-Slack platforms.
  const approve = async (target?: MessagingPairingApprovalTarget): Promise<void> => {
    const id = entryIdRef.current;
    if (!id || approving || !props.desktopApi?.approveMessagingPairing) return;
    setApproving(true);
    setError(undefined);
    try {
      await props.desktopApi.approveMessagingPairing({
        entryId: id,
        ...(target ? { target } : {}),
      });
      finalizePaired(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApproving(false);
    }
  };

  // Approve a single facet (user / channel / team) while keeping the
  // request open so the operator can approve the others too.
  const approveTarget = async (
    target: MessagingPairingApprovalTarget,
  ): Promise<void> => {
    const id = entryIdRef.current;
    if (!id || approving || !props.desktopApi?.approveMessagingPairing) return;
    setApproving(true);
    setError(undefined);
    try {
      await props.desktopApi.approveMessagingPairing({
        entryId: id,
        target,
        consume: false,
      });
      setApprovedTargets((prev) =>
        prev.includes(target) ? prev : [...prev, target],
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApproving(false);
    }
  };

  // Approve every remaining applicable facet, consume the request, and
  // move it into the paired summary. Also used as the "Done" action once
  // everything has been approved individually.
  const finishPairing = async (): Promise<void> => {
    const id = entryIdRef.current;
    if (!id || approving || !props.desktopApi?.approveMessagingPairing) return;
    const steps = slackApprovalSequence(
      { kind: observedChatKind, bucketId: observedChatBucketId },
      approvedTargets,
    );
    setApproving(true);
    setError(undefined);
    try {
      for (const step of steps) {
        await props.desktopApi.approveMessagingPairing({
          entryId: id,
          target: step.target,
          ...(step.consume ? {} : { consume: false }),
        });
      }
      finalizePaired(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApproving(false);
    }
  };

  const pairAnother = (): void => {
    // Re-arm the active-flow surface (Generate-code button, scope
    // picker) so the operator can issue another pairing token.
    // Keeps the `paired` list intact above the surface so the
    // previously-approved entities stay visible.
    setMessage(undefined);
    setEntryId(undefined);
    setResolution(undefined);
    setObservedActorLabel(undefined);
    setObservedChatLabel(undefined);
    setObservedChatKind(undefined);
    setObservedChatBucketId(undefined);
    setApprovedTargets([]);
    setError(undefined);
    setPairingAnother(true);
  };

  const generate = async (): Promise<void> => {
    if (!props.desktopApi?.generateMessagingPairingToken || busy) return;
    setBusy(true);
    setError(undefined);
    setResolution(undefined);
    try {
      const result = await props.desktopApi.generateMessagingPairingToken({
        platform: props.platform,
        scope,
      });
      setMessage(result.message);
      setEntryId(result.entry.id);
      // Auto-copy the freshly generated code so the operator can paste it
      // straight into chat; best-effort.
      await copy(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text?: string): Promise<void> => {
    const value = text ?? message;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // best effort — user can still select the text in the input
    }
  };

  const switchScope = (next: MessagingPairingScope): void => {
    if (next === scope) return;
    setScope(next);
    // Switching scope invalidates the in-flight pairing — the previous
    // token was scoped to the old kind. Clear it; the operator can
    // generate a new one for the freshly-selected scope.
    setMessage(undefined);
    setEntryId(undefined);
    setResolution(undefined);
    setError(undefined);
    setObservedActorLabel(undefined);
    setObservedChatLabel(undefined);
    setObservedChatKind(undefined);
    setObservedChatBucketId(undefined);
  };

  // Active-flow gate: when the operator hasn't approved anything
  // yet (or has clicked "+ Pair another"), render the full
  // token-generate / approve UI. After the first approval we
  // collapse to the compact "paired list + Pair another" layout —
  // surfacing exactly what the operator has authorized rather than
  // leaving the stale pairing code on screen.
  //
  // Note: an in-flight `message` or `resolution === "observed"`
  // also force active mode — this handles the rare case where a
  // pairing-changed event arrives *after* approval has already
  // cleared the surface (we want to react, not get stuck).
  const isActiveFlow =
    paired.length === 0
    || pairingAnother
    || message !== undefined
    || resolution === "observed";

  return (
    <div className="guided-setup__pairing">
      <div className="guided-setup__pairing-head">
        <span className="guided-setup__field-label">{props.title}</span>
        <span className="guided-setup__field-status">
          {paired.length > 0 && !isActiveFlow ? (
            <span className="guided-setup__field-pill is-ok">
              ✓ paired ({paired.length})
            </span>
          ) : resolution === "approved" ? (
            <span className="guided-setup__field-pill is-ok">✓ paired</span>
          ) : resolution === "observed" ? (
            <span className="guided-setup__field-pill is-ok">✓ message seen</span>
          ) : entryId ? (
            <span className="guided-setup__field-pill is-warn">
              waiting for message…
            </span>
          ) : null}
        </span>
      </div>
      {paired.length > 0 ? (
        <ul className="guided-setup__paired-list">
          {paired.map((entry) => (
            <li
              key={entry.entryId}
              className="guided-setup__paired-row"
            >
              <span className="guided-setup__paired-scope">
                {labelForPairingScope(props.platform, entry.scope)}
              </span>
              <span className="guided-setup__paired-actor">
                {entry.chat && entry.chat !== entry.actor
                  ? entry.chat
                  : entry.actor ?? "(no display name reported)"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {isActiveFlow ? (
        <>
          {props.options.length > 1 ? (
            <div className="guided-setup__segmented" role="radiogroup" aria-label="Pairing target">
              {props.options.map((option) => (
                <button
                  key={option.scope}
                  type="button"
                  role="radio"
                  aria-checked={scope === option.scope}
                  className={`guided-setup__segmented-btn${scope === option.scope ? " is-active" : ""}`}
                  onClick={() => switchScope(option.scope)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {activeOption?.help ? (
            // `div`, not `<p>`: help content for some scopes contains
            // its own `<p>` / `<ul>` blocks (e.g. Telegram bucket
            // scope surfaces a bot-privacy gotcha with bullets). Nested
            // `<p>` would be invalid HTML and React would silently
            // hoist children out, breaking the styling.
            <div className="guided-setup__field-sub">{activeOption.help}</div>
          ) : null}
          {message && resolution !== "observed" ? (
            // Pairing tokens are one-time-use; once the bot has
            // reported the message landed we hide the code (the
            // operator already sent it, displaying it longer just
            // invites a confusing second paste). Below this block
            // the Approve banner takes over.
            <div className="guided-setup__pairing-token">
              <code>{message}</code>
              <button
                type="button"
                className="guided-setup__btn guided-setup__btn--ghost"
                onClick={() => void copy()}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : !message ? (
            <button
              type="button"
              className="guided-setup__btn guided-setup__btn--ghost"
              disabled={busy || !props.desktopApi?.generateMessagingPairingToken}
              onClick={() => void generate()}
            >
              {busy ? "Generating…" : "Generate pairing code"}
            </button>
          ) : null}
          {resolution === "observed" ? (
            // The bot has reported the pairing message — surface an
            // inline Approve so the operator can finish the pairing
            // without navigating to Settings → Messaging Activity.
            <div className="guided-setup__pairing-approve">
              <div className="guided-setup__pairing-approve-text">
                <span>
                  Message received from{" "}
                  <strong>{observedActorLabel ?? "this contact"}</strong>
                  {observedChatLabel && observedChatLabel !== observedActorLabel ? (
                    <>
                      {" in "}
                      <strong>{observedChatLabel}</strong>
                    </>
                  ) : null}
                  . Approve to finish pairing.
                </span>
              </div>
              {props.platform === "slack" && scope === "observed" ? (
                (() => {
                  const targets = slackApplicableApprovalTargets({
                    kind: observedChatKind,
                    bucketId: observedChatBucketId,
                  });
                  const allApproved = targets.every((target) =>
                    approvedTargets.includes(target),
                  );
                  return (
                    <>
                      {targets.map((target) =>
                        approvedTargets.includes(target) ? (
                          <span
                            key={target}
                            className="guided-setup__field-pill is-ok"
                          >
                            ✓ {SLACK_APPROVAL_TARGET_LABELS[target].approved}
                          </span>
                        ) : (
                          <button
                            key={target}
                            type="button"
                            className="guided-setup__btn guided-setup__btn--ghost"
                            disabled={
                              approving || !props.desktopApi?.approveMessagingPairing
                            }
                            onClick={() => void approveTarget(target)}
                          >
                            {SLACK_APPROVAL_TARGET_LABELS[target].approve}
                          </button>
                        ),
                      )}
                      <button
                        type="button"
                        className="guided-setup__btn guided-setup__btn--primary"
                        disabled={
                          approving || !props.desktopApi?.approveMessagingPairing
                        }
                        onClick={() => void finishPairing()}
                      >
                        {approving
                          ? "Approving…"
                          : allApproved
                            ? "Done"
                            : targets.length > 1
                              ? "Approve all"
                              : "Approve"}
                      </button>
                    </>
                  );
                })()
              ) : (
                <button
                  type="button"
                  className="guided-setup__btn guided-setup__btn--primary"
                  disabled={approving || !props.desktopApi?.approveMessagingPairing}
                  onClick={() => void approve()}
                >
                  {approving ? "Approving…" : "Approve"}
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--link"
          onClick={pairAnother}
        >
          + Pair another
        </button>
      )}
      {error ? (
        <span className="guided-setup__field-error">{error}</span>
      ) : null}
    </div>
  );
}

/**
 * Human label for a pairing scope, scoped by the onboarding-known
 * platforms so we say "DM" / "Supergroup" for Telegram, "DM" /
 * "Server" for Discord, etc. Falls back to a generic "Group" /
 * "Conversation" label for any platform the wizard doesn't render
 * a setup step for (currently none — the union is wider than the
 * wizard's surface area to leave room for future providers).
 */
function labelForPairingScope(
  platform: MessagingChannelKind,
  scope: MessagingPairingScope,
): string {
  if (scope === "user_dm") return "DM";
  if (scope === "observed") {
    return platform === "slack" ? "Slack pairing" : "Observed";
  }
  switch (platform) {
    case "telegram":
      return "Supergroup";
    case "discord":
      return "Server";
    case "slack":
      return "Workspace";
    case "mattermost":
      return "Channel";
    case "feishu":
    case "line":
      return "Group";
    default:
      return "Conversation";
  }
}

/* ----------------------------------------------------------------
   Snapshot lookup helpers — read current platform values + secret state
   ---------------------------------------------------------------- */

function readSecretState(
  snapshot: DesktopSettingsSnapshot | undefined,
  name: DesktopSettingsSecretName,
): DesktopSettingsSecretState | undefined {
  if (!snapshot) return undefined;
  // Walk the messaging snapshot and find the matching secret by name. The
  // type-level mapping from secret-name to snapshot path is awkward to
  // express, so we lean on a small lookup table maintained inline.
  const map: Partial<Record<DesktopSettingsSecretName, DesktopSettingsSecretState>> = {
    telegramBotToken: snapshot.messaging.telegram.botToken,
    discordBotToken: snapshot.messaging.discord.botToken,
    mattermostBotToken: snapshot.messaging.mattermost.botToken,
    mattermostHmacSecret: snapshot.messaging.mattermost.hmacSecret,
    slackBotToken: snapshot.messaging.slack.botToken,
    slackAppToken: snapshot.messaging.slack.appToken,
    slackSigningSecret: snapshot.messaging.slack.signingSecret,
    feishuAppId: snapshot.messaging.feishu.appId,
    feishuAppSecret: snapshot.messaging.feishu.appSecret,
    feishuEncryptKey: snapshot.messaging.feishu.encryptKey,
    feishuVerificationToken: snapshot.messaging.feishu.verificationToken,
    lineChannelAccessToken: snapshot.messaging.line.channelAccessToken,
    lineChannelSecret: snapshot.messaging.line.channelSecret,
  };
  return map[name];
}

function readPlatformValue(
  snapshot: DesktopSettingsSnapshot | undefined,
  provider: GuidedMessagingProvider,
  key: string,
): unknown {
  if (!snapshot) return undefined;
  // The per-platform snapshot mixes `{ value }` fields with raw secret-state
  // objects; the secret entries get filtered out by the caller (text/segmented
  // rows never reference secret keys). Cast through `unknown` so TS lets us
  // do the lookup without enumerating every field type per platform.
  const platform = snapshot.messaging[provider] as unknown as Record<
    string,
    { value: unknown } | undefined
  >;
  const field = platform?.[key];
  return field?.value;
}

function buildPlatformPatch(
  provider: GuidedMessagingProvider,
  key: string,
  value: unknown,
): DesktopSettingsConfigPatch {
  return {
    messaging: {
      [provider]: { [key]: value },
    } as never,
  };
}

export function providerIcon(id: GuidedMessagingProvider, size: number) {
  switch (id) {
    case "telegram":
      return <TelegramIcon size={size} aria-hidden />;
    case "discord":
      return <DiscordIcon size={size} aria-hidden />;
    case "mattermost":
      return <MattermostIcon size={size} aria-hidden />;
    case "feishu":
      return <FeishuIcon size={size} aria-hidden />;
    case "slack":
      return <SlackIcon size={size} aria-hidden />;
    case "line":
      return <LineIcon size={size} aria-hidden />;
  }
}

/* ----------------------------------------------------------------
   Inline SVG icons (one-offs not in the shared icon library)
   ---------------------------------------------------------------- */

export function providerName(id: GuidedMessagingProvider): string {
  const row = PROVIDER_ROWS.find((p) => p.id === id);
  return row?.name ?? id;
}

