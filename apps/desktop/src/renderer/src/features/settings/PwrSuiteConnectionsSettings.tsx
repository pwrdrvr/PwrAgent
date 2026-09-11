import { useCallback, useEffect, useState } from "react";
import type { PwrGitConnectionStatus, PwrSnapConnectionStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsField, SettingsSection } from "./SettingsLayout";

type AppName = "PwrSnap" | "PwrGit";
type Status = PwrSnapConnectionStatus | PwrGitConnectionStatus;

function ConnectionRow(props: { app: AppName; desktopApi?: DesktopApi }) {
  const { app, desktopApi: api } = props;
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const read = app === "PwrGit" ? api?.readPwrGitConnectionStatus : api?.readPwrSnapConnectionStatus;
  const connect = app === "PwrGit" ? api?.connectPwrGit : api?.connectPwrSnap;
  const open = app === "PwrGit" ? api?.openPwrGit : api?.openPwrSnap;
  const download = app === "PwrGit" ? api?.openPwrGitDownload : api?.openPwrSnapDownload;

  const refresh = useCallback(async () => {
    if (!read) return;
    try {
      setStatus(await read());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [read]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const authorize = async () => {
    if (!connect) throw new Error("Connection setup is unavailable in this runtime.");
    const result = await connect();
    setStatus(result.status);
    if (result.outcome !== "connected") {
      setError(("detail" in result ? result.detail : undefined)
        ?? result.status.detail ?? "Authorization did not complete. Try connecting again.");
    }
  };
  const launch = async () => {
    const action = status?.availability === "not_installed" ? download : open;
    if (!action) throw new Error("Application launch is unavailable in this runtime.");
    const result = await action();
    if (!result.opened) throw new Error(result.error ?? `Could not open ${app}.`);
    await refresh();
  };
  const endpoint = status?.availability === "running";
  const authorization = error ? "Status check or setup failed"
    : !read ? "Status unavailable"
    : !status ? "Checking…"
    : status.configured ? "Authorization saved in PwrAgent" : "Not authorized in PwrAgent";

  return (
    <SettingsField
      label={app}
      sub={authorization}
      source="PwrAgent"
      help={status ? <>
        <span>{endpoint ? "Local MCP endpoint available." : "Local MCP endpoint unavailable."}</span>
        {status.detail ? <p>{status.detail}</p> : null}
        {status.configured ? <p>Saved authorization does not verify that a thread loaded the tools. Enable this connection on New Thread; ACP agents load it when their session starts.</p> : null}
      </> : undefined}
      error={error}
      control={<div className="settings-inline-actions">
        <button className="button button--secondary" type="button" disabled={busy || !read}
          onClick={() => void run(refresh)} aria-label={`Refresh ${app} connection`}>Refresh</button>
        {status && status.availability !== "not_installed" ? (
          <button className="button button--primary" type="button" disabled={busy || !connect}
            onClick={() => void run(authorize)}>
            {busy ? "Working…" : status.configured ? `Reauthorize ${app}` : `Connect to ${app}`}
          </button>
        ) : null}
        {status && !endpoint ? (
          <button className="button button--secondary" type="button" disabled={busy}
            onClick={() => void run(launch)}>
            {status.availability === "not_installed" ? `Get ${app}` : `Open ${app}`}
          </button>
        ) : null}
      </div>}
    />
  );
}

export function PwrSuiteConnectionsSettings(props: { desktopApi?: DesktopApi }) {
  return (
    <SettingsSection title="PwrAgent connections" eyebrow="PwrSuite" sectionId="pwrsuite-connections"
      description="Authorize these local apps in this PwrAgent profile, then select them for Codex or ACP threads such as Grok and Kimi. Connections registered directly with an agent are separate and are not shared here.">
      <ConnectionRow app="PwrSnap" desktopApi={props.desktopApi} />
      <ConnectionRow app="PwrGit" desktopApi={props.desktopApi} />
    </SettingsSection>
  );
}
