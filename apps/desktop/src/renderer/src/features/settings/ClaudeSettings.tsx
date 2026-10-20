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
      <SettingsPanelHead eyebrow="AI Providers" title="Claude" help="PwrAgent runs your installed Claude Code binary with your CLI sign-in." />
      <SettingsSection title="Local CLI" description="Install Claude Code from code.claude.com/docs/en/setup, then run claude auth login in your terminal.">
        <SettingsField label="Executable" control={installation?.executable ?? "Not found"} />
        <SettingsField label="Sign-in" control={
          !installation?.executable
            ? "Install the CLI to check sign-in."
            : installation.authStatus === "signed-in"
              ? "Signed in through the CLI"
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
