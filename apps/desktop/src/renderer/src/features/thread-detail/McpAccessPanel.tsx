import { useCallback, useEffect, useId, useState } from "react";
import {
  isAcpBackendId,
  mcpSelectionApplyTiming,
  type AppServerBackendKind,
  type McpConnectionStatus,
} from "@pwragent/shared";
import { CloseIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSwitch } from "../settings/SettingsSwitch";

export type McpAccessSelection = {
  connectionIds: string[];
  providerServersEnabled: boolean;
};

type McpAccessPanelProps = {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  /** Current selection; the caller owns it so launchpad and thread differ. */
  selection: McpAccessSelection;
  /** A failure the caller hit while loading the selection, shown inline. */
  readError?: string;
  onDismiss: () => void;
  onOpenSettings?: () => void;
  onSelectionChange: (selection: McpAccessSelection) => Promise<void>;
};

/**
 * Copy for when a change reaches the agent.
 *
 * Reporting a bare "saved" would be wrong for the common case: Codex picks
 * the selection up while starting the next turn, but an ACP agent resolves
 * MCP servers only when its session is created or reloaded.
 */
function applyTimingCopy(backend: AppServerBackendKind): string {
  return mcpSelectionApplyTiming(backend) === "next_turn"
    ? "Applies to your next message."
    : "Applies the next time this thread's session loads.";
}

export function formatMcpConnectionState(
  connection: McpConnectionStatus,
): string {
  if (!connection.configured || connection.state === "disconnected") {
    return "Not connected";
  }
  if (connection.state === "reauthorization_required") return "Login required";
  if (connection.state === "temporarily_unavailable") return "Unavailable";
  if (connection.state === "connecting") return "Connecting";
  if (connection.state === "refreshing") return "Refreshing";
  return "Ready";
}

export function McpAccessPanel(props: McpAccessPanelProps) {
  const [connections, setConnections] = useState<McpConnectionStatus[]>();
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const bodyId = useId();
  const backendSupported =
    props.backend === "codex" || isAcpBackendId(props.backend);
  // Only Codex can suppress the servers the agent loads for itself, so the
  // control is offered only where it can be honored.
  const canIsolate = props.backend === "codex";

  const refresh = useCallback(async () => {
    if (!props.desktopApi?.listMcpConnections) {
      setConnections([]);
      return;
    }
    try {
      const response = await props.desktopApi.listMcpConnections();
      setConnections(response.connections);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConnections([]);
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = async (
    next: McpAccessSelection,
    busyKey: string,
  ): Promise<void> => {
    setBusyId(busyKey);
    setError(undefined);
    try {
      await props.onSelectionChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  const available = connections?.filter((connection) => connection.enabled);
  const parked = connections?.filter((connection) => !connection.enabled);

  return (
    <aside className="live-work-rail mcp-access-panel" aria-label="MCP access">
      <header className="live-work-rail__header">
        <span className="live-work-rail__title">MCP access</span>
        <div className="live-work-rail__header-actions">
          <button
            aria-label="Close MCP access"
            className="mcp-inventory-panel__dismiss"
            title="Close MCP access"
            type="button"
            onClick={props.onDismiss}
          >
            <CloseIcon size={13} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="live-work-rail__body" id={bodyId}>
        {!backendSupported ? (
          <p className="mcp-access-panel__state">
            This backend cannot use MCP connections. Choose Codex or an ACP
            agent.
          </p>
        ) : null}
        {error ?? props.readError ? (
          <p
            className="mcp-access-panel__state mcp-access-panel__state--error"
            role="alert"
          >
            {error ?? props.readError}
          </p>
        ) : null}
        {connections === undefined ? (
          <p className="mcp-access-panel__state" role="status">
            Reading connections…
          </p>
        ) : connections.length === 0 ? (
          <div className="mcp-access-panel__empty">
            <p>No managed connections yet.</p>
            {props.onOpenSettings ? (
              <button
                className="button button--secondary"
                type="button"
                onClick={props.onOpenSettings}
              >
                Add a connection
              </button>
            ) : null}
          </div>
        ) : (
          <ul className="mcp-access-panel__list">
            {available?.map((connection) => {
              const healthy =
                connection.configured
                && connection.state !== "reauthorization_required"
                && connection.state !== "temporarily_unavailable";
              const checked = props.selection.connectionIds.includes(
                connection.id,
              );
              return (
                <li className="mcp-access-panel__row" key={connection.id}>
                  <div className="mcp-access-panel__row-body">
                    <span className="mcp-access-panel__name">
                      {connection.displayName}
                    </span>
                    {!healthy ? (
                      <span className="mcp-access-panel__detail">
                        {connection.detail
                          ?? formatMcpConnectionState(connection)}
                      </span>
                    ) : null}
                  </div>
                  {healthy ? (
                    <SettingsSwitch
                      checked={checked}
                      disabled={
                        !backendSupported || busyId === connection.id
                      }
                      label={`Use ${connection.displayName} in this thread`}
                      onChange={(enabled) => {
                        const ids = enabled
                          ? [
                              ...new Set([
                                ...props.selection.connectionIds,
                                connection.id,
                              ]),
                            ]
                          : props.selection.connectionIds.filter(
                              (id) => id !== connection.id,
                            );
                        void apply(
                          { ...props.selection, connectionIds: ids },
                          connection.id,
                        );
                      }}
                    />
                  ) : (
                    // An unhealthy connection keeps its row and gets the one
                    // action that can fix it. A bare disabled switch would
                    // state a problem and withhold the remedy.
                    <button
                      className="button button--secondary"
                      disabled={!props.onOpenSettings}
                      type="button"
                      onClick={props.onOpenSettings}
                    >
                      Authorize
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canIsolate && connections?.length ? (
          <div className="mcp-access-panel__policy">
            <div className="mcp-access-panel__row-body">
              <span className="mcp-access-panel__name">
                Agent&rsquo;s own MCP servers
              </span>
              <span className="mcp-access-panel__detail">
                Servers configured in Codex itself, outside PwrAgent.
              </span>
            </div>
            <SettingsSwitch
              checked={props.selection.providerServersEnabled}
              disabled={busyId === "provider" || !backendSupported}
              label="Use the agent's own MCP servers in this thread"
              onChange={(enabled) => {
                void apply(
                  { ...props.selection, providerServersEnabled: enabled },
                  "provider",
                );
              }}
            />
          </div>
        ) : null}
        {parked?.length ? (
          <p className="mcp-access-panel__state">
            {parked.length === 1
              ? `${parked[0].displayName} is turned off for every thread.`
              : `${parked.length} connections are turned off for every thread.`}
          </p>
        ) : null}
        <footer className="mcp-access-panel__footer">
          <span className="mcp-access-panel__detail">
            {applyTimingCopy(props.backend)}
          </span>
          {props.onOpenSettings ? (
            <button
              className="button button--ghost"
              type="button"
              onClick={props.onOpenSettings}
            >
              Manage connections
            </button>
          ) : null}
        </footer>
      </div>
    </aside>
  );
}

type ThreadMcpAccessPanelProps = {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  threadId: string;
  onDismiss: () => void;
  onOpenSettings?: () => void;
};

/**
 * The existing-thread wrapper. It reads the thread's saved selection on
 * demand rather than riding along on the navigation summary: the selection
 * is needed only while this panel is open, and widening the summary would
 * put it on every row of every lens.
 */
export function ThreadMcpAccessPanel(props: ThreadMcpAccessPanelProps) {
  const [selection, setSelection] = useState<McpAccessSelection>();
  const [error, setError] = useState<string>();
  const { backend, desktopApi, threadId } = props;

  useEffect(() => {
    let cancelled = false;
    const read = desktopApi?.readThreadMcpConnections;
    if (!read) {
      setSelection({ connectionIds: [], providerServersEnabled: true });
      return;
    }
    void (async () => {
      try {
        const response = await read({ backend, threadId });
        if (cancelled) return;
        setSelection({
          connectionIds: response.connectionIds,
          providerServersEnabled: response.providerServersEnabled,
        });
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setSelection({ connectionIds: [], providerServersEnabled: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend, desktopApi, threadId]);

  if (!selection) {
    return (
      <aside className="live-work-rail mcp-access-panel" aria-label="MCP access">
        <header className="live-work-rail__header">
          <span className="live-work-rail__title">MCP access</span>
        </header>
        <div className="live-work-rail__body">
          <p className="mcp-access-panel__state" role="status">
            Reading this thread&rsquo;s connections…
          </p>
        </div>
      </aside>
    );
  }

  return (
    <McpAccessPanel
      backend={backend}
      desktopApi={desktopApi}
      readError={error}
      selection={selection}
      onDismiss={props.onDismiss}
      onOpenSettings={props.onOpenSettings}
      onSelectionChange={async (next) => {
        const write = desktopApi?.setThreadMcpConnections;
        if (!write) throw new Error("This window cannot change MCP access.");
        const response = await write({
          backend,
          threadId,
          connectionIds: next.connectionIds,
          providerServersEnabled: next.providerServersEnabled,
        });
        // Trust the main process's answer over the optimistic value: a
        // rejected isolation request leaves the saved selection unchanged.
        setSelection({
          connectionIds: response.connectionIds,
          providerServersEnabled: response.providerServersEnabled,
        });
      }}
    />
  );
}
