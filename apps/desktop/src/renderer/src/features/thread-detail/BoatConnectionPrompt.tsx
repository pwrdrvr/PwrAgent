import { useEffect, useMemo, useState } from "react";
import {
  BOAT_LINKS,
  BOAT_MCP_CONNECTION_ID,
  backendLoadsMcpConnections,
  withMcpConnection,
} from "@pwragent/shared/contracts/mcp-connections";
import { type AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import boatMark from "../../assets/boat/boat-mark.svg";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSwitch } from "../settings/SettingsSwitch";
import { PwrSuiteTile, type PwrSuiteTileLineTone } from "./PwrSuiteTile";
import { usePwrSuiteConnectionStatus } from "./usePwrSuiteConnectionStatus";

const PITCH = "Build and test on a cloud Linux VM · sign in to start";

function about(cleanupOnPrClose: boolean, keepCredentialsOut: boolean) {
  return {
    eyebrow: "Third-party service · paid",
    title: "Cloud Linux machines for your agent",
    body:
      "Boat runs Linux machines your agent can build and test on, while the "
      + "thread stays on this computer. It is a separate paid service, billed "
      + "per second while a machine runs. PwrAgent holds your Boat API key and "
      + "makes every request itself: the agent gets sandbox tools, never the "
      + "key"
      + (keepCredentialsOut ? ", and sandboxes start without your account's credentials." : "."),
    note: (cleanupOnPrClose
      ? "Each thread opts in with its own switch. Once all of a thread's PRs "
        + "merge or close, PwrAgent deletes the sandboxes that thread created. "
        + "Closing the thread does not."
      : "Each thread opts in with its own switch. Closing a thread or merging "
        + "its PRs does not stop its sandboxes; auto-stop or the agent does.")
      + " Agents cannot make a sandbox port public.",
  };
}

/**
 * The launchpad's Boat tile: an ad until a key is stored, then a switch.
 *
 * Sign-in happens in Settings → Plugins, so every unfinished step sends the
 * operator to Boat's row there. Status comes from the connection list; it
 * is read again on window focus, after a failed read, and when main
 * announces a Boat change.
 */
export function BoatConnectionPrompt(props: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabled: boolean;
  /** A remote thread's tools run on its owner, whose key this window can't see. */
  remote: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onOpenSettings?: () => void;
}) {
  const listConnections = props.desktopApi?.listMcpConnections;
  const onConnectionsChanged = props.desktopApi?.onMcpConnectionsChanged;
  const read = useMemo(
    () => (listConnections && !props.remote
      ? async () => (await listConnections({})).connections.find(
        (entry) => entry.id === BOAT_MCP_CONNECTION_ID,
      ) ?? null
      : undefined),
    [listConnections, props.remote],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { status: connection, refresh, readError } = usePwrSuiteConnectionStatus(
    read,
    () => setError(undefined),
  );

  useEffect(() => {
    if (!read || !onConnectionsChanged) return;
    return onConnectionsChanged((change) => {
      if (change.connectionIds.includes(BOAT_MCP_CONNECTION_ID)) void refresh();
    });
  }, [onConnectionsChanged, read, refresh]);

  // A main without the built-in connection has nothing to offer.
  if (!read || connection === null) return null;

  const rejected = connection?.state === "reauthorization_required";
  const needsKey = !connection?.configured || connection.state === "disconnected" || rejected;
  const ready = Boolean(connection?.enabled && !needsKey);
  const backendSupported = backendLoadsMcpConnections(props.backend);
  const account = connection?.boatAccount;

  let line = PITCH;
  let tone: PwrSuiteTileLineTone = "pitch";
  if (error) {
    [line, tone] = [error, "error"];
  } else if (readError) {
    [line, tone] = [readError, "error"];
  } else if (!connection) {
    // Checking; the pitch says what this is meanwhile.
  } else if (connection.boatSignIn?.state === "waiting") {
    [line, tone] = [`Enter ${connection.boatSignIn.userCode} on Boat’s page in your browser`, "state"];
  } else if (rejected) {
    [line, tone] = ["Boat stopped accepting the stored key · sign in again", "state"];
  } else if (needsKey) {
    // An ad: the pitch, and Connect Boat.
  } else if (!connection.enabled) {
    [line, tone] = ["Turned off for every thread", "state"];
  } else if (account?.canStart === false) {
    [line, tone] = ["Boat can’t start new sandboxes for this account", "state"];
  } else if (!backendSupported) {
    [line, tone] = ["Choose Codex, Claude, or an ACP agent to use it here", "state"];
  } else {
    line = "Bills per second while a sandbox runs";
  }

  let action;
  if (!connection) {
    action = readError ? null : <span className="pwrsuite-tile__state">Checking…</span>;
  } else if (ready) {
    // A blocked account stops new machines, not running ones: the switch
    // stays so a thread can still list and stop.
    action = (
      <div className="pwrsuite-tile__switch">
        <span>Use in thread</span>
        <SettingsSwitch
          checked={props.enabled}
          disabled={busy || !backendSupported}
          label="Use Boat in this thread"
          onChange={(enabled) => {
            setBusy(true);
            setError(undefined);
            void props.onEnabledChange(enabled)
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => setBusy(false));
          }}
        />
      </div>
    );
  } else if (props.onOpenSettings) {
    action = (
      <button
        aria-label={rejected ? "Reconnect Boat in Settings" : "Connect Boat in Settings"}
        // The one tile that asks for something: it reads as the next step.
        className={"button " + (connection.enabled || needsKey ? "button--primary" : "button--secondary")}
        type="button"
        onClick={props.onOpenSettings}
      >
        {connection.boatSignIn?.state === "waiting"
          ? "Finish sign-in"
          : rejected ? "Reconnect" : needsKey ? "Connect Boat" : "Set up"}
      </button>
    );
  }

  return (
    <PwrSuiteTile
      siteUrl={BOAT_LINKS.home}
      name="Boat"
      icon={boatMark}
      iconPlate
      ariaLabel="Boat connection"
      about={about(
        connection?.boatCleanupOnPrClose !== false,
        connection?.boatPolicy?.keepCredentialsOut !== false,
      )}
      connected={ready}
      line={line}
      lineTone={tone}
      action={action}
    />
  );
}

/** Composes onto the thread's existing list, like the other tiles. */
export function boatConnectionIds(
  current: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  return withMcpConnection(current, BOAT_MCP_CONNECTION_ID, enabled);
}
