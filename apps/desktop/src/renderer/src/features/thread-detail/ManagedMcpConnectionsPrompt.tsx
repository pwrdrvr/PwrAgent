import { useCallback, useEffect, useState } from "react";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  isAcpBackendId,
  type AppServerBackendKind,
  type McpConnectionStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSwitch } from "../settings/SettingsSwitch";

export function ManagedMcpConnectionsPrompt(props: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabledConnectionIds: string[];
  remote: boolean;
  onEnabledChange: (
    connectionId: string,
    enabled: boolean,
  ) => Promise<void>;
}) {
  const [connections, setConnections] = useState<McpConnectionStatus[]>([]);
  const [busyConnectionId, setBusyConnectionId] = useState<string>();
  const [error, setError] = useState<string>();
  const backendSupported = props.backend === "codex"
    || isAcpBackendId(props.backend);

  const refresh = useCallback(async () => {
    if (props.remote || !props.desktopApi?.listMcpConnections) return;
    try {
      const response = await props.desktopApi.listMcpConnections();
      setConnections(response.connections.filter(
        (connection) => connection.id !== PWRSNAP_MCP_CONNECTION_ID,
      ));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [props.desktopApi, props.remote]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (props.remote || (!connections.length && !error)) return null;

  return (
    <aside
      className="pwrsnap-connection managed-mcp-connections"
      aria-label="Managed MCP connections"
    >
      <div className="managed-mcp-connections__icon" aria-hidden="true">MCP</div>
      <div className="pwrsnap-connection__copy">
        <p className="eyebrow">PwrAgent gateway</p>
        <h2>Managed MCP connections</h2>
        <p>
          Choose which centrally authorized connections this thread can use.
          OAuth tokens stay with PwrAgent.
        </p>
        {!backendSupported ? (
          <p className="pwrsnap-connection__detail">
            Choose Codex or an ACP agent to use MCP connections in this thread.
          </p>
        ) : null}
        {error ? (
          <p className="pwrsnap-connection__error" role="status">{error}</p>
        ) : null}
      </div>
      <div className="managed-mcp-connections__list">
        {connections.map((connection) => {
          const usable = connection.configured
            && connection.state !== "reauthorization_required";
          const checked = props.enabledConnectionIds.includes(connection.id);
          return (
            <div className="pwrsnap-connection__toggle" key={connection.id}>
              <span>{connection.displayName}</span>
              <SettingsSwitch
                checked={checked}
                disabled={
                  !backendSupported
                  || !usable
                  || busyConnectionId === connection.id
                }
                label={`Use ${connection.displayName} in this thread`}
                onChange={(enabled) => {
                  setBusyConnectionId(connection.id);
                  setError(undefined);
                  void props.onEnabledChange(connection.id, enabled)
                    .catch((cause) => {
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    })
                    .finally(() => setBusyConnectionId(undefined));
                }}
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
