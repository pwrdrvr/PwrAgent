import { useEffect, useRef, useState } from "react";
import type {
  AcpAgentSettingsEntry,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ManagedRuntimeProgress } from "../../../../shared/managed-runtime-progress";
import type { ClaudeSignInControls } from "../notifications/useClaudeSignIn";
import { grokSignInCommand } from "./acp-agent-copy";
import { AGENT_TABS, type AgentTabId } from "./guided-setup/AgentSetupSteps";
import { useCodexProfileLogin, rowLoginUrl } from "./guided-setup/CodexLoginRow";
import { useGuidedSetupLauncher } from "./guided-setup/GuidedSetupLauncher";
import {
  acpSetupStatus,
  claudeSetupStatus,
  codexSetupStatus,
} from "./harness-setup-status";
import { HarnessSetupChecklist, revealSettingsField } from "./HarnessSetupChecklist";
import { SettingsCopyValue } from "./SettingsCopyValue";
import {
  ANTIGRAVITY_ACCOUNT_FIELD_ID,
  ANTIGRAVITY_RUNTIME_FIELD_ID,
} from "./AntigravitySetup";

/*
 * The Setup checklist on each harness screen, wired to the actions that
 * screen already has. Every button here runs only when clicked; opening a
 * screen reads cached state and starts nothing.
 */

export const CODEX_PATH_FIELD_ID = "settings-codex-path";
export const CODEX_AUTH_PROFILE_FIELD_ID = "settings-codex-auth-profile";
export const CLAUDE_SIGN_IN_FIELD_ID = "settings-claude-sign-in";
export const acpPathsFieldId = (registryId: string) => `settings-acp-${registryId}-paths`;
export const acpManualPathFieldId = (registryId: string) => `settings-acp-${registryId}-manual-path`;

const CLAUDE_SETUP_GUIDE_URL = "https://code.claude.com/docs/en/setup";
const CLAUDE_SIGN_IN_COMMAND = "claude auth login";

function isWindows(desktopApi?: DesktopApi): boolean {
  return desktopApi?.platform === "win32"
    || /Windows/i.test(window.navigator.userAgent);
}

function guidedAgent(id: string): AgentTabId | undefined {
  return (AGENT_TABS as readonly string[]).includes(id) ? id as AgentTabId : undefined;
}

/* ----------------------------------------------------------------
   Codex
   ---------------------------------------------------------------- */

export function CodexSetupChecklist(props: {
  codex: DesktopSettingsSnapshot["models"]["codex"];
  backend?: BackendSummary;
  desktopApi?: DesktopApi;
  managedProgress?: ManagedRuntimeProgress;
  busy?: boolean;
  /** Rediscover Codex and re-read its models: why it failed, if it did. */
  onRefreshCodex: () => Promise<string | undefined>;
  onUseAutoDiscovery?: () => void;
  /** Re-read settings after a sign-in, so profiles name the account. */
  onSignedIn: () => Promise<void>;
}) {
  const launch = useGuidedSetupLauncher();
  const profiles = props.codex.profiles.profiles;
  const profile = profiles.find((candidate) => candidate.selected)
    ?? profiles.find((candidate) => candidate.name === "");
  const login = useCodexProfileLogin(props.desktopApi, profile?.name ?? "");
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number>();
  const [checkError, setCheckError] = useState<string>();
  const status = codexSetupStatus({
    codex: props.codex,
    backend: props.backend,
    managedProgress: props.managedProgress,
    login: login.state,
  });

  const onSignedInRef = useRef(props.onSignedIn);
  onSignedInRef.current = props.onSignedIn;
  // The check awaits a rediscovery that re-renders this panel; read the
  // runtime it found from the newest render, not the click's.
  const runtimeFoundRef = useRef(false);
  runtimeFoundRef.current = status.steps.some(
    (step) => step.id === "runtime" && step.state === "done",
  );
  const signedIn = login.state.kind === "ok";
  useEffect(() => {
    if (signedIn) void onSignedInRef.current();
  }, [signedIn]);

  const check = async (): Promise<void> => {
    setChecking(true);
    setCheckError(undefined);
    try {
      const failure = await props.onRefreshCodex();
      if (failure !== undefined) {
        setCheckError(failure);
        return;
      }
      // Sign-in is only worth asking about once a runtime answered: the
      // status check runs that runtime's `codex login status`.
      if (runtimeFoundRef.current) {
        await login.check();
      }
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  };

  const url = rowLoginUrl(login.state);
  const busy = props.busy === true || checking;
  const accountWorking = login.state.kind === "starting"
    || login.state.kind === "waiting"
    || login.state.kind === "checking";
  const signInNote = (
    <p className="settings-field__help">
      Opens OpenAI&rsquo;s sign-in page in your default browser. Codex keeps the
      sign-in in {profile?.name ? `the ${profile.displayName} profile` : "the System default profile"}.
    </p>
  );

  return (
    <HarnessSetupChecklist
      providerName="Codex"
      status={status}
      checkedAt={checkedAt}
      checking={checking}
      checkError={checkError}
      onCheck={() => void check()}
      onChange={{
        runtime: () => revealSettingsField(CODEX_PATH_FIELD_ID),
        account: () => revealSettingsField(CODEX_AUTH_PROFILE_FIELD_ID),
      }}
      controls={{
        runtime: status.action === "fix-path" ? (
          <div className="settings-inline-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => revealSettingsField(CODEX_PATH_FIELD_ID)}
            >
              Fix path
            </button>
            {props.onUseAutoDiscovery ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={props.onUseAutoDiscovery}
              >
                Use auto discovery
              </button>
            ) : null}
          </div>
        ) : status.action === "install" ? (
          <div className="settings-inline-actions">
            {launch ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => launch({ flow: "agents", agent: "codex" })}
              >
                Install step by step
              </button>
            ) : null}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => revealSettingsField(CODEX_PATH_FIELD_ID)}
            >
              Choose a path…
            </button>
          </div>
        ) : status.action === "check" ? (
          <div className="settings-inline-actions">
            <button type="button" className="button button--primary" disabled={busy} onClick={() => void check()}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </div>
        ) : undefined,
        account: accountWorking ? (
          <>
            <div className="settings-inline-actions">
              <button
                type="button"
                className="button button--primary"
                disabled={login.state.kind !== "waiting"}
                onClick={() => void login.check()}
              >
                {login.state.kind === "checking" ? "Checking…" : "Check now"}
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={login.state.kind !== "waiting"}
                onClick={() => void login.start()}
              >
                Re-open browser
              </button>
              {url ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => void login.copyUrl()}
                >
                  Copy link
                </button>
              ) : null}
            </div>
            <p className="settings-field__help">
              Wrong browser profile? Copy the link into the browser that is signed in to the right account.
            </p>
          </>
        ) : status.action === "manage-account" ? (
          <div className="settings-inline-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => revealSettingsField(CODEX_AUTH_PROFILE_FIELD_ID)}
            >
              Choose a profile
            </button>
          </div>
        ) : (
          <>
            <div className="settings-inline-actions">
              <button
                type="button"
                className="button button--primary"
                disabled={busy || !props.desktopApi?.startCodexAuthProfileLogin}
                onClick={() => void login.start()}
              >
                {login.state.kind === "error"
                  ? "Try again"
                  : status.action === "sign-in-again"
                    ? "Sign in again"
                    : "Sign in with browser"}
              </button>
              {status.action === "sign-in-again" ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => revealSettingsField(CODEX_AUTH_PROFILE_FIELD_ID)}
                >
                  Switch profile
                </button>
              ) : null}
            </div>
            {signInNote}
          </>
        ),
        ready: status.action === "check" ? (
          <div className="settings-inline-actions">
            <button type="button" className="button button--primary" disabled={busy} onClick={() => void check()}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </div>
        ) : undefined,
      }}
    />
  );
}

/* ----------------------------------------------------------------
   Claude
   ---------------------------------------------------------------- */

export function ClaudeSetupChecklist(props: {
  backend?: BackendSummary;
  desktopApi?: DesktopApi;
  claudeSignIn?: ClaudeSignInControls;
  /** Re-read the Claude summary the check refreshed in main. */
  onChecked: () => Promise<void>;
}) {
  const launch = useGuidedSetupLauncher();
  const installation = props.backend?.claude;
  const status = claudeSetupStatus(installation, {
    signingIn: props.claudeSignIn?.signingIn === true,
  });
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number>();
  const [checkError, setCheckError] = useState<string>();
  const desktopApi = props.desktopApi;

  // When main last checked Claude, from its cache. Reading it starts nothing.
  useEffect(() => {
    let current = true;
    void desktopApi?.readLastSettingsCredentialTest?.({ kind: "claude" })
      .then((result) => {
        if (current && result) setCheckedAt((at) => at ?? result.testedAt);
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [desktopApi]);

  // Every control that starts this is disabled while it runs.
  const check = async (): Promise<void> => {
    if (!desktopApi?.testSettingsCredentials) return;
    setChecking(true);
    setCheckError(undefined);
    try {
      const result = await desktopApi.testSettingsCredentials({ kind: "claude" });
      setCheckedAt(result.testedAt);
      await props.onChecked();
    } catch (caught) {
      setCheckError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  };

  const gateway = Boolean(installation?.gatewayUrl);
  const loginCommand = installation?.loginCommand ?? CLAUDE_SIGN_IN_COMMAND;
  const signIn = props.claudeSignIn?.onSignIn;

  return (
    <HarnessSetupChecklist
      providerName="Claude"
      status={status}
      checkedAt={checkedAt}
      checking={checking}
      checkError={checkError}
      onCheck={desktopApi?.testSettingsCredentials ? () => void check() : undefined}
      onChange={{ account: () => revealSettingsField(CLAUDE_SIGN_IN_FIELD_ID) }}
      controls={{
        runtime: status.action === "install" ? (
          <div className="settings-inline-actions">
            {launch ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => launch({ flow: "agents", agent: "claude" })}
              >
                Install step by step
              </button>
            ) : null}
            <a
              className="button button--ghost"
              href={CLAUDE_SETUP_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
            >
              Open install guide
            </a>
          </div>
        ) : status.action === "check" ? (
          <div className="settings-inline-actions">
            <button type="button" className="button button--primary" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check now"}
            </button>
          </div>
        ) : undefined,
        account: status.action === "check" ? (
          <div className="settings-inline-actions">
            <button type="button" className="button button--primary" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </div>
        ) : status.action === "sign-in" || status.action === "sign-in-again" ? (
          gateway ? (
            <div className="settings-inline-actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => revealSettingsField(CLAUDE_SIGN_IN_FIELD_ID)}
              >
                Sign in to your gateway
              </button>
            </div>
          ) : (
            <>
              {signIn ? (
                <div className="settings-inline-actions">
                  <button type="button" className="button button--primary" onClick={signIn}>
                    {status.action === "sign-in-again" ? "Sign in again" : "Sign in with browser"}
                  </button>
                </div>
              ) : null}
              <p className="settings-field__help">
                {signIn
                  ? "Opens Claude's sign-in page in your default browser. Prefer a terminal? Run this, then check again."
                  : "Run this in your terminal, then check again."}
              </p>
              <SettingsCopyValue
                value={loginCommand}
                desktopApi={desktopApi}
                label="Claude sign-in command"
              />
              <p className="settings-field__help">
                Using an API key, Bedrock, Vertex AI or a gateway instead? Set that up under Sign-in below.
              </p>
            </>
          )
        ) : undefined,
      }}
    />
  );
}

/* ----------------------------------------------------------------
   ACP agents
   ---------------------------------------------------------------- */

export function AcpSetupChecklist(props: {
  entry?: AcpAgentSettingsEntry;
  registryId: string;
  name: string;
  enabled: boolean;
  desktopApi?: DesktopApi;
  busy?: boolean;
  checking?: boolean;
  checkError?: string;
  onCheck: () => void;
  onEnable?: () => Promise<void>;
}) {
  const launch = useGuidedSetupLauncher();
  const { entry, registryId } = props;
  const status = acpSetupStatus(entry, { enabled: props.enabled });
  const [enabling, setEnabling] = useState(false);
  const busy = props.busy === true || props.checking === true || enabling;
  const wizardAgent = guidedAgent(registryId);
  const antigravity = registryId === "antigravity";
  const checkButton = (
    <button type="button" className="button button--primary" disabled={busy} onClick={props.onCheck}>
      {props.checking ? "Checking…" : "Check again"}
    </button>
  );

  return (
    <HarnessSetupChecklist
      providerName={props.name}
      status={status}
      checkedAt={entry?.lastDiscoveredAt}
      checking={props.checking}
      checkError={props.checkError}
      onCheck={props.enabled ? props.onCheck : undefined}
      checkInStep={status.action === "check" || status.action === "terminal-sign-in"}
      onChange={{ runtime: () => revealSettingsField(acpPathsFieldId(registryId)) }}
      controls={{
        enable: props.onEnable ? (
          <div className="settings-inline-actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => {
                setEnabling(true);
                void props.onEnable?.().finally(() => setEnabling(false));
              }}
            >
              {enabling ? "Turning on…" : "Turn on"}
            </button>
          </div>
        ) : undefined,
        runtime: status.action === "check" ? (
          <div className="settings-inline-actions">{checkButton}</div>
        ) : (
          <div className="settings-inline-actions">
            {antigravity ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => revealSettingsField(ANTIGRAVITY_RUNTIME_FIELD_ID)}
              >
                Go to install
              </button>
            ) : wizardAgent && launch ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => launch({ flow: "agents", agent: wizardAgent })}
              >
                Install step by step
              </button>
            ) : null}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => revealSettingsField(acpManualPathFieldId(registryId))}
            >
              Choose a path…
            </button>
          </div>
        ),
        account: status.action === "terminal-sign-in" ? (
          <>
            <SettingsCopyValue
              value={grokSignInCommand(entry?.activeCommand ?? "grok", isWindows(props.desktopApi))}
              desktopApi={props.desktopApi}
              label={`${props.name} sign-in command`}
            />
            <div className="settings-inline-actions">{checkButton}</div>
          </>
        ) : status.action === "manage-account" && antigravity ? (
          <div className="settings-inline-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => revealSettingsField(ANTIGRAVITY_ACCOUNT_FIELD_ID)}
            >
              Go to Google sign-in
            </button>
          </div>
        ) : status.action === "check" ? (
          <div className="settings-inline-actions">{checkButton}</div>
        ) : undefined,
        ready: status.action === "check" ? (
          <div className="settings-inline-actions">{checkButton}</div>
        ) : undefined,
      }}
    />
  );
}
