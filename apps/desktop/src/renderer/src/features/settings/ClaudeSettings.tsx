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
  return (
    <>
      <SettingsPanelHead eyebrow="AI Providers" title="Claude" help="PwrAgent runs Claude Code with your CLI sign-in." />
      <SettingsSection title="Runtime" description="Uses your system installation when it is at least as new as the bundled version; otherwise uses the bundled binary.">
        <SettingsField label="Executable" control={<span className="claude-runtime-path">{installation?.executable ?? "Not found"}</span>} />
        {installation?.executable ? <SettingsField label="Runtime" control={
          `${installation.source === "bundled" ? "Bundled with PwrAgent" : "System installation"}${installation.version ? ` · ${installation.version}` : ""}`
        } /> : <p>Install Claude Code from code.claude.com/docs/en/setup, then run claude auth login in your terminal.</p>}
        {installation?.loginCommand && installation.authStatus !== "signed-in" ? <SettingsField label="Sign-in command" control={<code className="claude-runtime-path">{installation.loginCommand}</code>} /> : null}
        <SettingsField label="Sign-in" control={
          !installation?.executable
            ? "Install the CLI to check sign-in."
            : installation.authStatus === "signed-in"
              ? "Signed in through the CLI"
              : installation.loginCommand
                ? `${installation.authStatus === "sign-in-required" ? "Sign-in required." : "Could not verify sign-in."} Run the command above in your terminal.`
                : installation.message ?? "Run claude auth login in your terminal, then check again."
        } />
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
