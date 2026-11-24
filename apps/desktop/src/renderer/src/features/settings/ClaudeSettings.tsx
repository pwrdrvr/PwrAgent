import { useCallback, useEffect, useRef, useState } from "react";
import { formatFilesystemPath } from "@pwragent/shared/path-display";
import { type BackendSummary } from "@pwragent/shared/contracts/backend";
import { type SettingsCredentialTestResult } from "@pwragent/shared/contracts/settings";
import type { ClaudeGatewaySignInProgress } from "@pwragent/shared/contracts/claude-gateway";
import type { DesktopApi } from "../../lib/desktop-api";
import { claudeProviderStatus } from "./claude-provider-status";
import { ClaudeGatewaySignInDialog, ClaudeGatewayStopDialog, claudeGatewayErrorMessage } from "./ClaudeGatewaySignInDialog";
import { SegmentedControl, SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsTestBlock } from "./SettingsTestBlock";

const CLAUDE_SETUP_GUIDE_URL = "https://code.claude.com/docs/en/setup";
const CLAUDE_TOKEN_GUIDE_URL = "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token";
const CLAUDE_SIGN_IN_COMMAND = "claude auth login";
const CLAUDE_PROVIDERS_GUIDE_URL = "https://code.claude.com/docs/en/third-party-integrations";

type ClaudeSignInMode = "account" | "gateway";

export function ClaudeSettings(props: {
  backend?: BackendSummary;
  desktopApi?: DesktopApi;
  onSignIn?: () => void;
  signingIn?: boolean;
  /** A connection test finished; re-read the summary it refreshed. */
  onChecked: () => Promise<void>;
}) {
  // Results older than the pane are the remembered last test, not a new one.
  const [mountedAt] = useState(() => Date.now());
  const handledTestRef = useRef(mountedAt);
  const onCheckedRef = useRef(props.onChecked);
  useEffect(() => {
    onCheckedRef.current = props.onChecked;
  }, [props.onChecked]);
  // Stable, and once per result: the test block reports from an effect keyed
  // on this callback, and the refresh it starts re-renders this pane.
  const onResult = useCallback((result: SettingsCredentialTestResult | undefined): void => {
    if (!result || result.testedAt < handledTestRef.current) return;
    handledTestRef.current = result.testedAt + 1;
    void onCheckedRef.current();
  }, []);
  const installation = props.backend?.claude;
  const status = claudeProviderStatus(installation);
  const executable = installation?.executable;
  const loginCommand = installation?.loginCommand ?? CLAUDE_SIGN_IN_COMMAND;
  const apiKey = installation?.authStatus === "signed-in" && installation.authMethod === "api-key";
  const signedIn = installation?.authStatus === "signed-in";
  const external = signedIn && installation.authMethod === "external";
  const gatewaySignedIn = signedIn && installation.authMethod === "gateway";
  const gatewayConfigured = gatewaySignedIn || Boolean(installation?.gatewayUrl);
  const canSignInToGateway = Boolean(props.desktopApi?.claudeGateway && installation?.gatewaySignIn);
  // The switch follows what Claude Code reports until the operator picks.
  const [chosenMode, setChosenMode] = useState<ClaudeSignInMode>();
  const mode: ClaudeSignInMode = chosenMode ?? (gatewayConfigured ? "gateway" : "account");
  const [urlDraft, setUrlDraft] = useState<string>();
  const gatewayUrl = urlDraft ?? installation?.gatewayUrl ?? "";
  const [starting, setStarting] = useState(false);
  const [gatewayError, setGatewayError] = useState<string>();
  const [signIn, setSignIn] = useState<{ progress: ClaudeGatewaySignInProgress; url: string }>();
  const [stopping, setStopping] = useState<{ busy: boolean; error?: string }>();
  const [signingOut, setSigningOut] = useState(false);

  const refresh = () => { void onCheckedRef.current().catch(() => {}); };
  const startGatewaySignIn = async (): Promise<void> => {
    const api = props.desktopApi;
    if (!api?.claudeGateway) return;
    setStarting(true);
    setGatewayError(undefined);
    setSignIn(undefined);
    try {
      const result = await api.claudeGateway({ action: "start", url: gatewayUrl });
      if (result.progress) setSignIn({ progress: result.progress, url: gatewayUrl.trim() });
    } catch (caught) {
      setGatewayError(claudeGatewayErrorMessage(caught));
    } finally {
      setStarting(false);
    }
  };
  const signOut = async (forget: boolean): Promise<void> => {
    const api = props.desktopApi;
    if (!api?.claudeGateway) return;
    await api.claudeGateway({ action: "signOut", forget });
    // Read the summary before the switch stops being pinned to the choice.
    await onCheckedRef.current().catch(() => {});
  };
  const chooseMode = (next: ClaudeSignInMode) => {
    if (next === "account" && gatewayConfigured) {
      setStopping({ busy: false });
      return;
    }
    setGatewayError(undefined);
    setChosenMode(next);
  };

  return (
    <SettingsSection
      title="Runtime"
      description="Uses your installed Claude Code, or the copy bundled with PwrAgent if yours is older."
      chip={status.label}
      chipKind={status.tone}
    >
      <div className="settings-fields">
        {installation && !executable ? (
          <SettingsField
            label="Install Claude Code"
            sub="Install it, sign in from your terminal, then test again."
            control={
              <div className="settings-fields">
                <SettingsCopyValue
                  value={CLAUDE_SIGN_IN_COMMAND}
                  desktopApi={props.desktopApi}
                  label="Claude sign-in command"
                />
                <div className="settings-inline-actions">
                  <a
                    className="button button--secondary"
                    href={CLAUDE_SETUP_GUIDE_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open install guide
                  </a>
                </div>
              </div>
            }
          />
        ) : null}
        {executable ? (
          <SettingsField
            label="Claude Code"
            control={
              <div className="settings-gh-status">
                <span className="settings-pathrow__path" title={executable}>
                  Path: {formatFilesystemPath(executable)}
                </span>
                <span className="settings-pathrow__path">
                  {installation?.source === "bundled" ? "Bundled with PwrAgent" : "Installed"}
                  {installation?.version ? ` · ${installation.version}` : ""}
                </span>
              </div>
            }
          />
        ) : null}
        {executable && external ? (
          <SettingsField
            label="Sign-in"
            sub="Claude Code is set up for another provider, such as Bedrock, Vertex AI, Foundry, or an API key. PwrAgent uses that setup as it is."
            control={
              <div className="settings-inline-actions">
                <a className="button button--secondary" href={CLAUDE_PROVIDERS_GUIDE_URL} target="_blank" rel="noreferrer">
                  Open provider guide
                </a>
              </div>
            }
          />
        ) : null}
        {executable && !external && (canSignInToGateway || gatewayConfigured) ? (
          <SettingsField
            label="Sign-in"
            sub="How Claude Code reaches a model."
            control={
              <SegmentedControl<ClaudeSignInMode>
                label="Claude sign-in method"
                options={[
                  { label: "Claude account", value: "account" },
                  { label: "LLM gateway", value: "gateway" },
                ]}
                value={mode}
                onChange={chooseMode}
              />
            }
          />
        ) : null}
        {executable && !external && mode === "gateway" && gatewaySignedIn ? (
          <SettingsField
            label="Gateway"
            sub="Claude Code renews the gateway token itself."
            control={
              <div className="settings-fields">
                <span className="settings-pathrow__path" title={installation?.gatewayUrl}>
                  {installation?.gatewayUrl ?? "Signed in through a gateway"}
                </span>
                <div className="settings-inline-actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={starting || signingOut || !canSignInToGateway || !installation?.gatewayUrl}
                    onClick={() => { void startGatewaySignIn(); }}
                  >
                    {starting ? "Starting…" : "Sign in again"}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={starting || signingOut}
                    onClick={() => {
                      setSigningOut(true);
                      setGatewayError(undefined);
                      void signOut(false)
                        .catch((caught: unknown) => setGatewayError(claudeGatewayErrorMessage(caught)))
                        .finally(() => setSigningOut(false));
                    }}
                  >
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              </div>
            }
            error={gatewayError}
          />
        ) : null}
        {executable && !external && mode === "gateway" && !gatewaySignedIn ? (
          <SettingsField
            label="Gateway URL"
            sub="Your LLM gateway's address, such as a BiFrost server."
            help={canSignInToGateway
              ? <>Claude Code opens the gateway’s sign-in page in your browser and keeps the token. This also sets <code>forceLoginGatewayUrl</code> in Claude Code’s <code>settings.json</code>, so <code>claude</code> in a terminal signs in through this gateway too.</>
              : "Gateway sign-in needs Claude Code 2.1.330 or newer. Update Claude Code, then test again."}
            control={
              <div className="settings-fields">
                <input
                  aria-label="Gateway URL"
                  className="settings-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://gateway.example.com"
                  value={gatewayUrl}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && gatewayUrl.trim() && !starting) void startGatewaySignIn();
                  }}
                />
                <div className="settings-inline-actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={!canSignInToGateway || !gatewayUrl.trim() || starting}
                    onClick={() => { void startGatewaySignIn(); }}
                  >
                    {starting ? "Starting…" : "Sign in to gateway"}
                  </button>
                </div>
              </div>
            }
            error={gatewayError}
          />
        ) : null}
        {executable && !external && mode === "account" ? (
          <SettingsField
            label="Claude sign-in"
            sub={props.onSignIn ? "Sign in through your browser or run the command in your terminal." : "Run this in your terminal, then test again."}
            control={
              <div className="settings-fields">
                {props.onSignIn ? (
                  <div className="settings-inline-actions">
                    <button
                      type="button"
                      className={`button button--${installation?.authStatus === "signed-in" ? "secondary" : "primary"}`}
                      disabled={props.signingIn}
                      onClick={props.onSignIn}
                    >
                      {props.signingIn ? "Waiting for Claude sign-in…" : "Sign in to Claude"}
                    </button>
                  </div>
                ) : null}
                <SettingsCopyValue
                  value={apiKey ? `${loginCommand} --claudeai` : loginCommand}
                  desktopApi={props.desktopApi}
                  label="Claude sign-in command"
                />
              </div>
            }
          />
        ) : null}
        {apiKey ? (
          <SettingsField
            label="Billing"
            control={<span>Billed to your API key.</span>}
          />
        ) : null}
        {gatewaySignedIn && mode === "gateway" ? (
          <SettingsField
            label="Billing"
            control={<span>Billed by your gateway. Claude plan limits do not apply.</span>}
          />
        ) : null}
        <SettingsField
          label="Connection test"
          sub="Checks Claude Code’s saved sign-in. It does not check credits or usage limits."
          control={
            <SettingsTestBlock
              kind="claude"
              desktopApi={props.desktopApi}
              icon={<span aria-hidden="true">C</span>}
              defaultName={formatFilesystemPath(executable ?? "claude")}
              defaultSub={executable ? "claude auth status" : "Claude Code not found"}
              onResult={onResult}
            />
          }
        />
        {executable && mode === "account" && !external ? (
          <SettingsField
            label="Unattended CLI jobs"
            sub={<>For standalone jobs, run <code>claude setup-token</code> and set <code>CLAUDE_CODE_OAUTH_TOKEN</code> in the job’s environment. PwrAgent filters inherited credential variables.</>}
            control={
              <div className="settings-inline-actions">
                <a className="button button--secondary" href={CLAUDE_TOKEN_GUIDE_URL} target="_blank" rel="noreferrer">
                  Open token guide
                </a>
              </div>
            }
          />
        ) : null}
      </div>
      {signIn && props.desktopApi ? (
        <ClaudeGatewaySignInDialog
          key={signIn.progress.id}
          desktopApi={props.desktopApi}
          initial={signIn.progress}
          gatewayUrl={signIn.url}
          onDone={() => {
            setSignIn(undefined);
            setChosenMode(undefined);
            setUrlDraft(undefined);
            refresh();
          }}
          onRetry={() => { void startGatewaySignIn(); }}
          onClose={() => {
            setSignIn(undefined);
            // The URL is in Claude Code's settings now; show what it reports.
            refresh();
          }}
        />
      ) : null}
      {stopping ? (
        <ClaudeGatewayStopDialog
          gatewayUrl={installation?.gatewayUrl}
          signedIn={gatewaySignedIn}
          busy={stopping.busy}
          error={stopping.error}
          onCancel={() => setStopping(undefined)}
          onConfirm={() => {
            setStopping({ busy: true });
            void signOut(true).then(
              () => {
                setStopping(undefined);
                // The refreshed summary names no gateway, so the switch follows it again.
                setChosenMode(undefined);
                setUrlDraft(undefined);
              },
              (caught: unknown) => setStopping({ busy: false, error: claudeGatewayErrorMessage(caught) }),
            );
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
