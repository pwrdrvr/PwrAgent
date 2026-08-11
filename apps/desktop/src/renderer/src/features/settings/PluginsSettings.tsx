import { useCallback, useEffect, useState } from "react";
import type {
  CodexMcpAuthStatus,
  CodexMcpServerSummary,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

type ActionNotice = {
  kind: "error" | "success" | "working";
  text: string;
};

export function PluginsSettings(props: {
  desktopApi?: DesktopApi;
  snapshot: DesktopSettingsSnapshot;
}) {
  const [servers, setServers] = useState<CodexMcpServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyServer, setBusyServer] = useState<string>();
  const [removeCandidate, setRemoveCandidate] =
    useState<CodexMcpServerSummary>();
  const [notice, setNotice] = useState<ActionNotice>();
  const selectedProfile = props.snapshot.models.codex.profiles.profiles.find(
    (profile) => profile.selected,
  );

  const loadServers = useCallback(async () => {
    if (!props.desktopApi?.listCodexMcpServers) {
      setNotice({
        kind: "error",
        text: "MCP management is unavailable in this build.",
      });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await props.desktopApi.listCodexMcpServers({
        detail: "toolsAndAuthOnly",
      });
      setServers(response.servers);
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  useEffect(() => props.desktopApi?.onAgentEvent?.((event) => {
    if (event.notification.method !== "mcpServer/oauthLogin/completed") {
      return;
    }
    const params = event.notification.params;
    const name = typeof params.name === "string"
      ? params.name
      : typeof params.serverName === "string"
        ? params.serverName
        : undefined;
    if (!name || name !== busyServer) {
      return;
    }
    setBusyServer(undefined);
    if (params.success === true) {
      setNotice({ kind: "success", text: `${name} login completed.` });
      void props.desktopApi?.reloadCodexMcpServers?.()
        .then(loadServers)
        .catch((error: unknown) => {
          setNotice({
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    setNotice({
      kind: "error",
      text: typeof params.error === "string"
        ? params.error
        : `${name} login did not complete.`,
    });
  }), [busyServer, loadServers, props.desktopApi]);

  const reloadConfig = async () => {
    if (!props.desktopApi?.reloadCodexMcpServers) return;
    setNotice({ kind: "working", text: "Reloading MCP configuration..." });
    try {
      await props.desktopApi.reloadCodexMcpServers();
      await loadServers();
      setNotice({
        kind: "success",
        text: "MCP configuration reloaded. Loaded threads use it on their next turn.",
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const relogin = async (server: CodexMcpServerSummary) => {
    if (!props.desktopApi?.startCodexMcpServerLogin) return;
    setBusyServer(server.name);
    setNotice({
      kind: "working",
      text: `Waiting for ${server.name} login to complete...`,
    });
    try {
      const result = await props.desktopApi.startCodexMcpServerLogin({
        name: server.name,
      });
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setBusyServer(undefined);
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const removeServer = async () => {
    const server = removeCandidate;
    if (!server || !props.desktopApi?.removeCodexMcpServer) return;
    setBusyServer(server.name);
    setNotice({ kind: "working", text: `Removing ${server.name}...` });
    try {
      await props.desktopApi.removeCodexMcpServer({ name: server.name });
      setRemoveCandidate(undefined);
      await loadServers();
      setNotice({
        kind: "success",
        text: `${server.name} was removed from this Codex profile.`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyServer(undefined);
    }
  };

  return (
    <SettingsSectionStack paneId="plugins" aria-label="Plugin settings">
      <SettingsPanelHead
        eyebrow="Plugins"
        title="Plugin connections"
        help="Inspect and repair the MCP servers configured for this PwrAgent profile's selected Codex profile."
        action={
          <button
            className="button button--secondary"
            disabled={loading || Boolean(busyServer)}
            title="Re-read installed MCP configuration and expose it to loaded Codex threads on their next turn."
            type="button"
            onClick={() => void reloadConfig()}
          >
            Reload config
          </button>
        }
      />

      <SettingsSection
        eyebrow="Plugins"
        title="MCP servers"
        sectionId="mcp-servers"
        description="Relogin replaces expired OAuth credentials. Remove deletes only this server's configuration from the selected Codex profile."
        chip={`${servers.length} configured`}
      >
        <div className="settings-plugin-profile">
          <span>Codex profile</span>
          <strong>{selectedProfile?.displayName ?? "Default"}</strong>
          <code>
            {selectedProfile?.codexHome
              ?? props.snapshot.models.codex.profiles.effectiveCodexHome}
          </code>
        </div>
        {notice ? (
          <p
            className={`settings-plugin-notice settings-plugin-notice--${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        ) : null}
        {loading ? (
          <p className="settings-empty">Loading MCP servers...</p>
        ) : servers.length ? (
          <div className="settings-mcp-list">
            {servers.map((server) => (
              <McpServerRow
                key={server.name}
                busy={busyServer === server.name}
                server={server}
                onRelogin={() => void relogin(server)}
                onRemove={() => setRemoveCandidate(server)}
              />
            ))}
          </div>
        ) : (
          <p className="settings-empty">No MCP servers are configured.</p>
        )}
      </SettingsSection>

      {removeCandidate ? (
        <div className="settings-confirm-modal" role="presentation">
          <div
            aria-labelledby="remove-mcp-server-heading"
            aria-modal="true"
            className="settings-confirm-dialog settings-confirm-dialog--danger"
            role="dialog"
          >
            <h2 id="remove-mcp-server-heading">Remove MCP server?</h2>
            <p>
              Remove <strong>{removeCandidate.name}</strong> from the selected
              Codex profile. Existing threads receive the new configuration on
              their next turn.
            </p>
            <div className="settings-confirm-dialog__actions">
              <button
                className="button button--secondary"
                disabled={busyServer === removeCandidate.name}
                type="button"
                onClick={() => setRemoveCandidate(undefined)}
              >
                Cancel
              </button>
              <button
                className="button button--ghost settings-profile-row__button--danger"
                disabled={busyServer === removeCandidate.name}
                type="button"
                onClick={() => void removeServer()}
              >
                Remove server
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsSectionStack>
  );
}

function McpServerRow(props: {
  busy: boolean;
  server: CodexMcpServerSummary;
  onRelogin: () => void;
  onRemove: () => void;
}) {
  const server = props.server;
  const canRelogin = server.authStatus === "oAuth"
    || server.authStatus === "notLoggedIn";
  return (
    <article className="settings-mcp-row">
      <div className="settings-mcp-row__body">
        <strong>{server.name}</strong>
        <span>{server.tools.length} tools</span>
        {server.startupError ? (
          <p className="settings-mcp-row__error">{server.startupError}</p>
        ) : null}
      </div>
      <div className="settings-mcp-row__chips">
        <span className="settings-pathrow__chip">
          {formatAuthStatus(server.authStatus)}
        </span>
        {server.startupStatus ? (
          <span
            className={`settings-pathrow__chip${
              server.startupStatus === "failed"
                ? " settings-pathrow__chip--err"
                : server.startupStatus === "ready"
                  ? " settings-pathrow__chip--ok"
                  : ""
            }`}
          >
            {server.startupStatus}
          </span>
        ) : null}
      </div>
      <div className="settings-mcp-row__actions">
        {canRelogin ? (
          <button
            className="button button--secondary"
            disabled={props.busy}
            type="button"
            onClick={props.onRelogin}
          >
            {props.busy ? "Waiting..." : "Relogin"}
          </button>
        ) : null}
        <button
          className="button button--ghost settings-mcp-row__remove"
          disabled={props.busy}
          type="button"
          onClick={props.onRemove}
        >
          Remove
        </button>
      </div>
    </article>
  );
}

function formatAuthStatus(status: CodexMcpAuthStatus): string {
  if (status === "oAuth") return "OAuth";
  if (status === "bearerToken") return "Bearer token";
  if (status === "notLoggedIn") return "Login required";
  return "No login";
}
