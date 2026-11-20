import { useCallback, useEffect, useRef, useState } from "react";
import { formatFilesystemPath } from "@pwragent/shared/path-display";
import { type BackendSummary } from "@pwragent/shared/contracts/backend";
import { type SettingsCredentialTestResult } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import { claudeProviderStatus } from "./claude-provider-status";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsTestBlock } from "./SettingsTestBlock";

const CLAUDE_SETUP_GUIDE_URL = "https://code.claude.com/docs/en/setup";
const CLAUDE_TOKEN_GUIDE_URL = "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token";
const CLAUDE_SIGN_IN_COMMAND = "claude auth login";

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
        {executable ? (
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
        {executable ? (
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
    </SettingsSection>
  );
}
