import { useCallback, useEffect, useState } from "react";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  isAcpBackendId,
  withMcpConnection,
  type AppServerBackendKind,
  type PwrSnapConnectionStatus,
} from "@pwragent/shared";
import pwrSnapIcon from "../../assets/pwrsnap/pwrsnap-app-icon.png";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSwitch } from "../settings/SettingsSwitch";

export function PwrSnapConnectionPrompt(props: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabled: boolean;
  remoteOwnerLabel?: string;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const [status, setStatus] = useState<PwrSnapConnectionStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const backendSupported = props.backend === "codex" || isAcpBackendId(props.backend);

  const refresh = useCallback(async (): Promise<void> => {
    if (!props.desktopApi?.readPwrSnapConnectionStatus) return;
    try {
      setStatus(await props.desktopApi.readPwrSnapConnectionStatus());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const runAction = async (action: () => Promise<void>): Promise<void> => {
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

  const connect = async (): Promise<void> => {
    if (!props.desktopApi?.connectPwrSnap) {
      throw new Error("PwrSnap connections require the desktop app.");
    }
    const response = await props.desktopApi.connectPwrSnap();
    setStatus(response.status);
    if (response.outcome === "needs_local_agent_access") {
      setError(
        "Enable Local Agent Access in PwrSnap, then choose Connect to PwrSnap again.",
      );
    }
  };

  const getPwrSnap = async (): Promise<void> => {
    const response = await props.desktopApi?.openPwrSnapDownload?.();
    if (response && !response.opened) {
      throw new Error(response.error ?? "Could not open the PwrSnap download.");
    }
  };

  const openPwrSnap = async (): Promise<void> => {
    const response = await props.desktopApi?.openPwrSnap?.();
    if (response && !response.opened) {
      throw new Error(response.error ?? "Could not open PwrSnap.");
    }
  };

  const configured = status?.configured === true;
  const running = status?.availability === "running";
  const installed = status?.availability === "installed" || running;
  const remoteOwnerLabel = props.remoteOwnerLabel?.trim();

  // A remote launchpad may only expose PwrSnap after its owner explicitly
  // reports a configured, running connection. Never turn the viewer's local
  // install state into a remote pairing or download affordance.
  if (remoteOwnerLabel && (!configured || !running)) {
    return null;
  }

  if (remoteOwnerLabel) {
    const switchLabel = `Enable PwrSnap on ${remoteOwnerLabel} in this thread`;
    const description =
      `Enable it to let this thread use PwrSnap on ${remoteOwnerLabel}, `
      + "where the thread runs. This does not connect to PwrSnap on this device.";
    return (
      <aside className="mcp-connection" aria-label="Remote PwrSnap connection">
        <img
          alt=""
          aria-hidden="true"
          className="mcp-connection__icon"
          src={pwrSnapIcon}
        />
        <div className="mcp-connection__copy">
          <p className="eyebrow">Remote PwrSuite connection</p>
          <h2>{`PwrSnap is available on ${remoteOwnerLabel}`}</h2>
          <p>{description}</p>
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
            <span>Enable PwrSnap in this thread</span>
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
    <aside className="mcp-connection" aria-label="PwrSnap connection">
      <img
        alt=""
        aria-hidden="true"
        className="mcp-connection__icon"
        src={pwrSnapIcon}
      />
      <div className="mcp-connection__copy">
        <p className="eyebrow">PwrSuite connection</p>
        <h2>Screenshots your agents can actually use</h2>
        <p>
          PwrSnap captures and organizes screenshots, then lets your agents find,
          edit, and export the right image without digging through folders.
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
        ) : !installed ? (
          <button
            className="button button--primary"
            disabled={busy}
            type="button"
            onClick={() => void runAction(getPwrSnap)}
          >
            Get PwrSnap
          </button>
        ) : !configured ? (
          <button
            className="button button--primary"
            disabled={busy}
            type="button"
            onClick={() => void runAction(connect)}
          >
            {busy ? "Connecting…" : "Connect to PwrSnap"}
          </button>
        ) : running ? (
          <div className="mcp-connection__toggle">
            <span>Use in this thread</span>
            <SettingsSwitch
              checked={props.enabled}
              disabled={busy || !backendSupported}
              label="Use PwrSnap in this thread"
              onChange={(enabled) => {
                void runAction(async () => await props.onEnabledChange(enabled));
              }}
            />
          </div>
        ) : (
          <button
            className="button button--secondary"
            disabled={busy}
            type="button"
            onClick={() => void runAction(async () => {
              await openPwrSnap();
              await refresh();
            })}
          >
            Open PwrSnap
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
export function pwrSnapConnectionIds(
  current: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  return withMcpConnection(current, PWRSNAP_MCP_CONNECTION_ID, enabled);
}
