import { useState } from "react";
import {
  PWRGIT_MCP_CONNECTION_ID,
  isAcpBackendId,
  withMcpConnection,
  type AppServerBackendKind,
} from "@pwragent/shared";
import pwrGitIcon from "../../assets/pwrgit/pwrgit-app-icon.png";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSwitch } from "../settings/SettingsSwitch";
import {
  connectionActionError,
  usePwrSuiteConnectionStatus,
} from "./usePwrSuiteConnectionStatus";

export function PwrGitConnectionPrompt(props: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabled: boolean;
  remoteOwnerLabel?: string;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { status, setStatus, refresh, unreachable } =
    usePwrSuiteConnectionStatus(
      props.desktopApi?.readPwrGitConnectionStatus,
      () => setError(undefined),
    );
  const backendSupported =
    props.backend === "codex" || isAcpBackendId(props.backend);

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(connectionActionError(cause));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    if (!props.desktopApi?.connectPwrGit) {
      throw new Error("PwrGit connections require the desktop app.");
    }
    const response = await props.desktopApi.connectPwrGit();
    setStatus(response.status);
    // A response without detail is one whose `status.detail` already says
    // what to do (the switch to turn on); repeating it here would stack the
    // same sentence twice on the card.
    if (response.outcome !== "connected" && response.detail) {
      setError(response.detail);
    }
  };

  const getPwrGit = async (): Promise<void> => {
    const response = await props.desktopApi?.openPwrGitDownload?.();
    if (response && !response.opened) {
      throw new Error(response.error ?? "Could not open the PwrGit download.");
    }
  };

  const openPwrGit = async (): Promise<void> => {
    const response = await props.desktopApi?.openPwrGit?.();
    if (response && !response.opened) {
      throw new Error(response.error ?? "Could not open PwrGit.");
    }
  };

  const configured = status?.configured === true;
  const running = status?.availability === "running";
  const installed = status?.availability === "installed" || running;
  const remoteOwnerLabel = props.remoteOwnerLabel?.trim();

  // A remote launchpad may only expose PwrGit after its owner reports a
  // configured connection. The viewer's own install state says nothing about
  // the machine the thread runs on, which is why the federation-scoped API
  // leaves this card without a status reader until PwrGit has a federation
  // surface of its own.
  if (remoteOwnerLabel && !configured) {
    return null;
  }

  if (remoteOwnerLabel) {
    const switchLabel = `Enable PwrGit on ${remoteOwnerLabel} in this thread`;
    return (
      <aside className="mcp-connection" aria-label="Remote PwrGit connection">
        <img
          alt=""
          aria-hidden="true"
          className="mcp-connection__icon"
          src={pwrGitIcon}
        />
        <div className="mcp-connection__copy">
          <p className="eyebrow">Remote PwrSuite connection</p>
          <h2>{`PwrGit is available on ${remoteOwnerLabel}`}</h2>
          <p>
            {`Enable it to let this thread read repository and pull-request status on ${remoteOwnerLabel}, `
              + "where the thread runs. This does not connect to PwrGit on this device."}
          </p>
          {!backendSupported ? (
            <p className="mcp-connection__detail">
              Choose Codex or an ACP agent to use MCP connections in this thread.
            </p>
          ) : null}
          {error ? (
            <p className="mcp-connection__error" role="status">{error}</p>
          ) : null}
        </div>
        <div className="mcp-connection__action">
          <div className="mcp-connection__toggle">
            <span>Enable PwrGit in this thread</span>
            <SettingsSwitch
              checked={props.enabled}
              disabled={busy || !backendSupported}
              label={switchLabel}
              onChange={(enabled) => {
                void runAction(async () => await props.onEnabledChange(enabled));
              }}
            />
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="mcp-connection" aria-label="PwrGit connection">
      <img
        alt=""
        aria-hidden="true"
        className="mcp-connection__icon"
        src={pwrGitIcon}
      />
      <div className="mcp-connection__copy">
        <p className="eyebrow">PwrSuite connection</p>
        <h2>Your repositories, without the guessing</h2>
        <p>
          PwrGit lets your agents find the right checkout, read branch and
          worktree state, and follow pull-request and CI status — without
          being told where anything lives.
        </p>
        {status ? (
          <p className="mcp-connection__detail">
            {configured ? "PwrAgent authorization saved" : "Not connected through PwrAgent"}
            {configured ? ". Enable it for each thread that needs access." : ". Codex and other agents’ own connections are separate."}
          </p>
        ) : null}
        {status?.detail ? (
          <p className="mcp-connection__detail">{status.detail}</p>
        ) : null}
        {unreachable ? (
          <p className="mcp-connection__detail">
            PwrAgent could not check PwrGit yet. It will keep trying.
          </p>
        ) : null}
        {!backendSupported && configured ? (
          <p className="mcp-connection__detail">
            Choose Codex or an ACP agent to use MCP connections in this thread.
          </p>
        ) : null}
        {error ? (
          <p className="mcp-connection__error" role="status">{error}</p>
        ) : null}
      </div>
      <div className="mcp-connection__action">
        {!status ? (
          <span className="mcp-connection__checking">Checking…</span>
        ) : configured && running ? (
          <div className="mcp-connection__toggle">
            <span>Use in this thread</span>
            <SettingsSwitch
              checked={props.enabled}
              disabled={busy || !backendSupported}
              label="Use PwrGit in this thread"
              onChange={(enabled) => {
                void runAction(async () => await props.onEnabledChange(enabled));
              }}
            />
          </div>
        ) : !installed ? (
          <button
            className="button button--primary"
            disabled={busy}
            type="button"
            onClick={() => void runAction(getPwrGit)}
          >
            Get PwrGit
          </button>
        ) : !running ? (
          <button
            className="button button--secondary"
            disabled={busy}
            type="button"
            onClick={() => void runAction(async () => {
              await openPwrGit();
              await refresh();
            })}
          >
            Open PwrGit
          </button>
        ) : (
          <button
            className="button button--primary"
            disabled={busy}
            type="button"
            onClick={() => void runAction(connect)}
          >
            {busy ? "Waiting for approval…" : "Connect to PwrGit"}
          </button>
        )}
      </div>
    </aside>
  );
}

/**
 * Composes onto the thread's existing list rather than replacing it: PwrSnap
 * and PwrGit share one `mcpConnectionIds` array, so a replacing toggle would
 * silently disable the other card.
 */
export function pwrGitConnectionIds(
  current: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  return withMcpConnection(current, PWRGIT_MCP_CONNECTION_ID, enabled);
}
