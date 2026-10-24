import { useCallback, useEffect, useRef, useState } from "react";
import { formatFilesystemPath, type BackendSummary, type SettingsCredentialTestResult } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { claudeProviderStatus } from "./claude-provider-status";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsTestBlock } from "./SettingsTestBlock";

const CLAUDE_SETUP_GUIDE_URL = "https://code.claude.com/docs/en/setup";
const CLAUDE_SIGN_IN_COMMAND = "claude auth login";

export function ClaudeSettings(props: {
  backend?: BackendSummary;
  desktopApi?: DesktopApi;
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
  const signedOut = Boolean(executable) && installation?.authStatus !== "signed-in";

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
        {signedOut ? (
          <SettingsField
            label="Sign in"
            sub="Run this in your terminal, then test again."
            control={
              <SettingsCopyValue
                value={loginCommand}
                desktopApi={props.desktopApi}
                label="Claude sign-in command"
              />
            }
          />
        ) : null}
        {apiKey ? (
          <SettingsField
            label="Billing"
            sub="Billed to your API key. To use your Claude plan, sign in with your Claude account."
            control={
              <SettingsCopyValue
                value={`${loginCommand} --claudeai`}
                desktopApi={props.desktopApi}
                label="Claude account sign-in command"
              />
            }
          />
        ) : null}
        <SettingsField
          label="Connection test"
          sub="Confirms Claude Code runs and is signed in. It does not check credits or usage limits."
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
      </div>
    </SettingsSection>
  );
}
