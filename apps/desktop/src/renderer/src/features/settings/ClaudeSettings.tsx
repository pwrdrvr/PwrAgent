import { useState } from "react";
import type { BackendSummary } from "@pwragent/shared";
import { SettingsField, SettingsPanelHead, SettingsSection } from "./SettingsLayout";

export function ClaudeSettings(props: {
  backend?: BackendSummary;
  onCheck: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const installation = props.backend?.claude;
  const authenticated = installation?.authStatus === "signed-in";
  const apiKey = authenticated && installation.authMethod === "api-key";
  const signInLabel = installation?.authMethod === "api-key"
    ? "API key configured in the CLI"
    : installation?.authMethod === "claude-account"
      ? "Signed in with a Claude account"
      : installation?.authMethod === "external"
        ? "External provider authentication configured in the CLI"
        : "CLI reports signed in; authentication method unavailable";
  return (
    <>
      <SettingsPanelHead eyebrow="AI Providers" title="Claude" help="PwrAgent runs Claude Code with your CLI sign-in." />
      <SettingsSection title="Runtime" description="Uses your system installation when it is at least as new as the bundled version; otherwise uses the bundled binary.">
        <SettingsField label="Executable" control={<span className="claude-runtime-path">{installation?.executable ?? "Not found"}</span>} />
        {installation?.executable ? <SettingsField label="Runtime" control={
          `${installation.source === "bundled" ? "Bundled with PwrAgent" : "System installation"}${installation.version ? ` · ${installation.version}` : ""}`
        } /> : <p>Install Claude Code from code.claude.com/docs/en/setup, then run claude auth login in your terminal.</p>}
        {installation?.loginCommand && (!authenticated || apiKey) ? <SettingsField label={apiKey ? "Claude account sign-in" : "Sign-in command"} control={<code className="claude-runtime-path">{installation.loginCommand}{apiKey ? " --claudeai" : ""}</code>} /> : null}
        <SettingsField label="Sign-in" control={
          !installation?.executable
            ? "Install the CLI to check sign-in."
            : authenticated
              ? signInLabel
              : installation.loginCommand
                ? `${installation.authStatus === "sign-in-required" ? "Sign-in required." : "Could not verify sign-in."} Run the command above in your terminal.`
                : installation.message ?? "Run claude auth login in your terminal, then check again."
        } />
        {authenticated ? <SettingsField label="Usage access" control={apiKey
          ? "API billing applies. This check does not verify credits. To use your Claude subscription, run the Claude account sign-in command above in your terminal."
          : "This check confirms CLI sign-in only; it does not verify available credits or remaining usage."
        } /> : null}
        <SettingsField label="Connection check" error={error} control={
          <div className="settings-inline-actions">
            <button type="button" className="button button--secondary" disabled={checking}
              onClick={async () => {
                setChecking(true);
                setError(undefined);
                try { await props.onCheck(); }
                catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
                finally { setChecking(false); }
              }}>
              {checking ? "Checking…" : "Check installation and sign-in"}
            </button>
          </div>
        } />
      </SettingsSection>
    </>
  );
}
