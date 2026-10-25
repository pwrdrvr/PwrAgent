import { useEffect, useMemo, useRef, useState } from "react";
import {
  SANDBOXER_LINKS,
  SANDBOXER_MCP_CONNECTION_ID,
  backendLoadsMcpConnections,
  isSandboxerAccountLimited,
  withMcpConnection,
  type AppServerBackendKind,
} from "@pwragent/shared";
import sandboxerMark from "../../assets/sandboxer/sandboxer-mark.svg";
import { PopoutIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { openExternalUrl } from "../../lib/open-external-url";
import { SettingsSwitch } from "../settings/SettingsSwitch";
import { PwrSuiteTile, type PwrSuiteTileLineTone } from "./PwrSuiteTile";
import { usePwrSuiteConnectionStatus } from "./usePwrSuiteConnectionStatus";

const PITCH = "Cloud Linux machines for your agent · paid service";

const ABOUT = {
  eyebrow: "Third-party service · paid",
  title: "Cloud Linux machines for your agent",
  body:
    "Sandboxer runs Linux machines your agent can build, test, and host apps "
    + "on, while the thread stays on this computer. It is a separate paid "
    + "service, billed per second while a machine runs. PwrAgent uses the "
    + "Sandboxer CLI's own login.",
  note:
    "Each thread opts in with its own switch. Closing a thread does not stop "
    + "its sandbox; auto-stop or the agent does.",
};

/**
 * The launchpad's Sandboxer tile: an ad until it is set up, then a switch.
 *
 * Most operators have never heard of Sandboxer, so a missing CLI shows what
 * it is and links to Sandboxer's install guide. Every other unfinished step
 * (sign-in, a plan, offering it to threads) is done in Settings → Plugins,
 * where the setup ladder lives, so the tile sends the operator there.
 *
 * Status comes from the connection list, which reads `sbx status` through
 * main's cache. It never retires live sessions the way Refresh status can.
 * It is read again on window focus, after a failed read, and on the way
 * back from Settings, which opens over this view without a focus change.
 */
export function SandboxerConnectionPrompt(props: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabled: boolean;
  /** A remote thread's tools run on its owner, whose CLI this window can't see. */
  remote: boolean;
  /** Settings is open over this view. Closing it re-reads status. */
  settingsOpen?: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onOpenSettings?: () => void;
}) {
  const listConnections = props.desktopApi?.listMcpConnections;
  const read = useMemo(
    () => (listConnections && !props.remote
      ? async () => (await listConnections()).connections.find(
        (entry) => entry.id === SANDBOXER_MCP_CONNECTION_ID,
      ) ?? null
      : undefined),
    [listConnections, props.remote],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { status: connection, refresh, readError } = usePwrSuiteConnectionStatus(read);

  const settingsOpen = props.settingsOpen === true;
  const settingsWasOpen = useRef(settingsOpen);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen) void refresh();
    settingsWasOpen.current = settingsOpen;
  }, [refresh, settingsOpen]);

  // A main without the built-in connection has nothing to offer.
  if (!read || connection === null) return null;

  const ready = connection?.configured === true && connection.enabled;
  const backendSupported = backendLoadsMcpConnections(props.backend);
  const state = connection?.sandboxerCliState;
  const limited = isSandboxerAccountLimited(state);

  let line = PITCH;
  let tone: PwrSuiteTileLineTone = "pitch";
  if (error) {
    [line, tone] = [error, "error"];
  } else if (readError) {
    // Repeated failed reads; the last status, if any, stays meanwhile.
    [line, tone] = [readError, "error"];
  } else if (!connection) {
    // Checking; the pitch says what this is meanwhile.
  } else if (state === "cli_missing") {
    // An ad: the pitch, and Get Sandboxer.
  } else if (state === "not_signed_in") {
    [line, tone] = ["Sign in with sbx onboard to use it here", "state"];
  } else if (state === "no_plan") {
    [line, tone] = ["Needs a plan before it can start a machine", "state"];
  } else if (state === "unavailable") {
    [line, tone] = ["Can’t check Sandboxer right now", "state"];
  } else if (!connection.enabled) {
    [line, tone] = ["Turned off for every thread", "state"];
  } else if (limited) {
    [line, tone] = [
      state === "out_of_credit"
        ? "Out of credit · new sandboxes won’t start"
        : state === "billing_issue"
          ? "Billing issue · new sandboxes won’t start"
          : "Sandboxer can’t start new machines",
      "state",
    ];
  } else if (!backendSupported) {
    [line, tone] = ["Choose Codex, Claude, or an ACP agent to use it here", "state"];
  } else {
    line = "Bills per second while a sandbox runs";
  }

  let action;
  if (!connection) {
    action = readError ? null : <span className="pwrsuite-tile__state">Checking…</span>;
  } else if (state === "cli_missing") {
    action = (
      <button
        className="button button--secondary"
        type="button"
        onClick={() => openExternalUrl(SANDBOXER_LINKS.quickstart)}
      >
        Get Sandboxer
        <PopoutIcon size={12} />
      </button>
    );
  } else if (ready) {
    // A billing problem stops new machines, not running ones: the switch
    // stays so a thread can still reach list and stop.
    action = (
      <div className="pwrsuite-tile__switch">
        <span>Use in thread</span>
        <SettingsSwitch
          checked={props.enabled}
          disabled={busy || !backendSupported}
          label="Use Sandboxer in this thread"
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
        aria-label="Set up Sandboxer in Settings"
        className="button button--secondary"
        type="button"
        onClick={props.onOpenSettings}
      >
        Set up
      </button>
    );
  }

  return (
    <PwrSuiteTile
      siteUrl={SANDBOXER_LINKS.home}
      name="Sandboxer"
      icon={sandboxerMark}
      ariaLabel="Sandboxer connection"
      about={ABOUT}
      connected={ready && state === "signed_in"}
      line={line}
      lineTone={tone}
      action={action}
    />
  );
}

/**
 * Composes onto the thread's existing list, like the PwrSuite tiles: all of
 * them share one `mcpConnectionIds` array.
 */
export function sandboxerConnectionIds(
  current: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  return withMcpConnection(current, SANDBOXER_MCP_CONNECTION_ID, enabled);
}
