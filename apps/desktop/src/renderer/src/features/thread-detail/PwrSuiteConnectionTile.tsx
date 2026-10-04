import { useState } from "react";
import {
  isAcpBackendId,
  type AppServerBackendKind,
  type PwrGitConnectionStatus,
  type PwrSnapConnectionStatus,
} from "@pwragent/shared";
import type { PwrSuiteAppId } from "../../../../shared/pwrsuite-installer";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSwitch } from "../settings/SettingsSwitch";
import {
  PwrSuiteInstallAction,
  PwrSuiteTile,
  pwrSuiteInstallLine,
  type PwrSuiteTileLineTone,
} from "./PwrSuiteTile";
import { usePwrSuiteInstaller } from "./usePwrSuiteInstaller";
import {
  connectionActionError,
  usePwrSuiteConnectionStatus,
} from "./usePwrSuiteConnectionStatus";

type PwrSuiteConnectionStatus = PwrGitConnectionStatus | PwrSnapConnectionStatus;

/**
 * What differs between the PwrGit and PwrSnap tiles. Everything else — the
 * states, the actions, and what a remote thread may see — is one flow.
 */
export type PwrSuiteConnectionApp<Status extends PwrSuiteConnectionStatus> = {
  app: PwrSuiteAppId;
  name: string;
  icon: string;
  pitch: string;
  about: { title: string; body: string };
  readStatus: (() => Promise<Status>) | undefined;
  /** Pairs and answers the status to show, or a short reason it did not. */
  connect: (() => Promise<{ status: Status; error?: string }>) | undefined;
  openApp: (() => Promise<{ opened: boolean; error?: string }>) | undefined;
  /** The tile's line while Connect waits on the app. */
  waitingLine: string;
  /** PwrSnap pairs whether or not it is open; PwrGit has to be running. */
  connectsWhileClosed: boolean;
  /** PwrSnap's remote tile needs the owner's app running, not just paired. */
  remoteNeedsRunning: boolean;
};

export function PwrSuiteConnectionTile<Status extends PwrSuiteConnectionStatus>(props: {
  config: PwrSuiteConnectionApp<Status>;
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabled: boolean;
  remoteOwnerLabel?: string;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const { config } = props;
  const [busy, setBusy] = useState<"connect" | "other">();
  const [error, setError] = useState<string>();
  const { status, setStatus, refresh, unreachable, readError } =
    usePwrSuiteConnectionStatus(config.readStatus, () => setError(undefined));
  const backendSupported =
    props.backend === "codex" || isAcpBackendId(props.backend);
  const configured = status?.configured === true;
  const running = status?.availability === "running";
  const installed = status?.availability === "installed" || running;
  const remoteOwnerLabel = props.remoteOwnerLabel?.trim();
  const installer = usePwrSuiteInstaller(
    config.app,
    // Only a local tile that knows the app is missing reads the installer:
    // the read may ask GitHub for the latest release.
    !remoteOwnerLabel && status !== undefined && !installed
      ? props.desktopApi
      : undefined,
  );

  const runAction = async (
    kind: "connect" | "other",
    action: () => Promise<void>,
  ): Promise<void> => {
    setBusy(kind);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(connectionActionError(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const threadSwitch = (label: string, visibleLabel: string) => (
    <div className="pwrsuite-tile__switch">
      <span>{visibleLabel}</span>
      <SettingsSwitch
        checked={props.enabled}
        disabled={busy !== undefined || !backendSupported || unreachable}
        label={label}
        onChange={(enabled) => {
          void runAction("other", async () => await props.onEnabledChange(enabled));
        }}
      />
    </div>
  );

  // A remote launchpad may only offer the app once its owner reports it
  // connected. The viewer's own install state says nothing about the machine
  // the thread runs on, so a remote tile never downloads, pairs, or launches.
  if (remoteOwnerLabel) {
    if (!configured || (config.remoteNeedsRunning && !running)) {
      return null;
    }
    return (
      <PwrSuiteTile
        app={config.app}
        name={config.name}
        icon={config.icon}
        ariaLabel={`Remote ${config.name} connection`}
        tag={remoteOwnerLabel}
        connected={!unreachable}
        line={
          error ?? readError ?? (
            backendSupported ? (
              <>
                Runs on <b>{remoteOwnerLabel}</b>, where this thread runs
              </>
            ) : (
              "Choose Codex or an ACP agent to use it here"
            )
          )
        }
        lineTone={error ? "error" : readError ? "state" : backendSupported ? "pitch" : "state"}
        action={threadSwitch(
          `Enable ${config.name} on ${remoteOwnerLabel} in this thread`,
          "Use in thread",
        )}
      />
    );
  }

  const connect = async (): Promise<void> => {
    if (!config.connect) {
      throw new Error(`${config.name} connections require the desktop app.`);
    }
    const response = await config.connect();
    setStatus(response.status);
    if (response.error) setError(response.error);
  };

  const openApp = async (): Promise<void> => {
    const response = await config.openApp?.();
    if (response && !response.opened) {
      throw new Error(response.error ?? `Could not open ${config.name}.`);
    }
    await refresh();
  };

  const installLine = !installed ? pwrSuiteInstallLine(installer, config.name) : undefined;
  let line: string = config.pitch;
  let tone: PwrSuiteTileLineTone = "pitch";
  if (error) {
    [line, tone] = [error, "error"];
  } else if (readError) {
    [line, tone] = [readError, "state"];
  } else if (busy === "connect") {
    [line, tone] = [config.waitingLine, "state"];
  } else if (installLine) {
    [line, tone] = [installLine.text, installLine.tone];
  } else if (configured && !backendSupported) {
    [line, tone] = ["Choose Codex or an ACP agent to use it here", "state"];
  } else if (status?.detail) {
    [line, tone] = [status.detail, "state"];
  } else if (configured && installed && !running) {
    [line, tone] = [`Connected · ${config.name} isn’t open`, "state"];
  }

  const canConnect = !configured && (running || (installed && config.connectsWhileClosed));
  let action;
  if (!status || unreachable) {
    action = (
      <span className="pwrsuite-tile__state">
        {unreachable ? "Can’t check right now" : "Checking…"}
      </span>
    );
  } else if (!installed) {
    action = (
      <PwrSuiteInstallAction app={config.app} name={config.name} installer={installer} />
    );
  } else if (configured && running) {
    action = threadSwitch(`Use ${config.name} in this thread`, "Use in thread");
  } else if (canConnect) {
    action = (
      <button
        aria-label={busy === "connect" ? undefined : `Connect to ${config.name}`}
        className={
          "button " + (busy === "connect" ? "button--secondary" : "button--primary")
        }
        disabled={busy !== undefined}
        type="button"
        onClick={() => void runAction("connect", connect)}
      >
        {busy === "connect" ? "Waiting…" : "Connect"}
      </button>
    );
  } else {
    action = (
      <button
        className="button button--secondary"
        disabled={busy !== undefined}
        type="button"
        onClick={() => void runAction("other", openApp)}
      >
        {`Open ${config.name}`}
      </button>
    );
  }

  return (
    <PwrSuiteTile
      app={config.app}
      name={config.name}
      icon={config.icon}
      ariaLabel={`${config.name} connection`}
      about={config.about}
      connected={configured && running && !unreachable}
      line={line}
      lineTone={tone}
      action={action}
    />
  );
}
