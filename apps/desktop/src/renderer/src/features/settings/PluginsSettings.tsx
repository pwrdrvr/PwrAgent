import { useCallback, useEffect, useRef, useState } from "react";
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
  kind: "error" | "info" | "success" | "working";
  text: string;
};

type PendingAction = {
  kind: "login" | "reload" | "remove";
  name: string;
};

type StartupResult = {
  status: "ready" | "failed" | "cancelled";
  error?: string;
};

const LOGIN_STARTUP_WAIT_MS = 5_000;
const OAUTH_LOGIN_WAIT_MS = 120_000;

function normalizeCodexHome(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/$/, "")
    .replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

export function PluginsSettings(props: {
  desktopApi?: DesktopApi;
  snapshot: DesktopSettingsSnapshot;
}) {
  const [servers, setServers] = useState<CodexMcpServerSummary[]>([]);
  const [activeCodexHome, setActiveCodexHome] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingActionState] = useState<PendingAction>();
  const pendingActionRef = useRef<PendingAction | undefined>(undefined);
  const startupWaiterRef = useRef<{
    name: string;
    resolve: (result: StartupResult | undefined) => void;
    timer: number;
  } | undefined>(undefined);
  const oauthWaitTimerRef = useRef<number | undefined>(undefined);
  const [removeCandidate, setRemoveCandidate] =
    useState<CodexMcpServerSummary>();
  const [notice, setNotice] = useState<ActionNotice>();
  const selectedProfile = props.snapshot.models.codex.profiles.profiles.find(
    (profile) => profile.selected,
  );
  const selectedCodexHome = selectedProfile?.codexHome
    ?? props.snapshot.models.codex.profiles.effectiveCodexHome;
  const activeProfile = activeCodexHome
    ? props.snapshot.models.codex.profiles.profiles.find(
        (profile) => normalizeCodexHome(profile.codexHome)
          === normalizeCodexHome(activeCodexHome),
      )
    : undefined;
  const profileChanged = Boolean(
    activeCodexHome
    && normalizeCodexHome(activeCodexHome)
      !== normalizeCodexHome(selectedCodexHome),
  );

  const setPendingAction = useCallback((action?: PendingAction) => {
    pendingActionRef.current = action;
    setPendingActionState(action);
  }, []);

  const clearOAuthWaitTimer = useCallback(() => {
    if (oauthWaitTimerRef.current === undefined) return;
    window.clearTimeout(oauthWaitTimerRef.current);
    oauthWaitTimerRef.current = undefined;
  }, []);

  const cancelLoginWait = useCallback((message?: string) => {
    clearOAuthWaitTimer();
    if (pendingActionRef.current?.kind !== "login") return;
    setPendingAction(undefined);
    setNotice({
      kind: "info",
      text: message ?? "Stopped waiting for login. You can try again.",
    });
  }, [clearOAuthWaitTimer, setPendingAction]);

  const scheduleLoginTimeout = useCallback((name: string) => {
    clearOAuthWaitTimer();
    oauthWaitTimerRef.current = window.setTimeout(() => {
      if (
        pendingActionRef.current?.kind === "login"
        && pendingActionRef.current.name === name
      ) {
        cancelLoginWait(`${name} login timed out. You can try again.`);
      }
    }, OAUTH_LOGIN_WAIT_MS);
  }, [cancelLoginWait, clearOAuthWaitTimer]);

  const cancelStartupWait = useCallback(() => {
    const waiter = startupWaiterRef.current;
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    startupWaiterRef.current = undefined;
    waiter.resolve(undefined);
  }, []);

  const waitForGlobalStartup = useCallback((name: string) => {
    cancelStartupWait();
    return new Promise<StartupResult | undefined>((resolve) => {
      const timer = window.setTimeout(() => {
        if (startupWaiterRef.current?.name === name) {
          startupWaiterRef.current = undefined;
        }
        resolve(undefined);
      }, LOGIN_STARTUP_WAIT_MS);
      startupWaiterRef.current = { name, resolve, timer };
    });
  }, [cancelStartupWait]);

  const loadServers = useCallback(async () => {
    if (!props.desktopApi?.listCodexMcpServers) {
      setNotice({
        kind: "error",
        text: "MCP management is unavailable in this build.",
      });
      setLoading(false);
      return false;
    }
    setLoading(true);
    try {
      const response = await props.desktopApi.listCodexMcpServers({
        detail: "toolsAndAuthOnly",
      });
      setActiveCodexHome(response.codexHome);
      setServers(response.servers);
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setLoading(false);
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  useEffect(() => () => {
    clearOAuthWaitTimer();
    const waiter = startupWaiterRef.current;
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    startupWaiterRef.current = undefined;
  }, [clearOAuthWaitTimer]);

  const finishLogin = useCallback(async (name: string) => {
    clearOAuthWaitTimer();
    const codexHome = activeCodexHome;
    if (!props.desktopApi?.reloadCodexMcpServers) {
      setNotice({
        kind: "error",
        text: "MCP config reload is unavailable in this build.",
      });
      setPendingAction(undefined);
      return;
    }
    if (!codexHome) {
      setNotice({ kind: "error", text: "Active Codex profile is unavailable." });
      setPendingAction(undefined);
      return;
    }
    setPendingAction({ kind: "reload", name });
    setNotice({
      kind: "working",
      text: `${name} login completed. Reloading its MCP connection...`,
    });
    const startup = waitForGlobalStartup(name);
    try {
      await props.desktopApi.reloadCodexMcpServers({ codexHome });
      const startupResult = await startup;
      const refreshed = await loadServers();
      if (!refreshed) return;
      if (startupResult?.status === "failed") {
        setNotice({
          kind: "error",
          text: startupResult.error
            ? `${name} login completed, but startup failed: ${startupResult.error}`
            : `${name} login completed, but its MCP connection failed to start.`,
        });
      } else if (startupResult?.status === "cancelled") {
        setNotice({
          kind: "error",
          text: `${name} login completed, but its MCP connection startup was cancelled.`,
        });
      } else {
        setNotice({
          kind: "success",
          text: `${name} login completed and its row was refreshed.`,
        });
      }
    } catch (error) {
      cancelStartupWait();
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(undefined);
    }
  }, [
    cancelStartupWait,
    clearOAuthWaitTimer,
    activeCodexHome,
    loadServers,
    props.desktopApi,
    setPendingAction,
    waitForGlobalStartup,
  ]);

  useEffect(() => props.desktopApi?.onAgentEvent?.((event) => {
    if (event.notification.method === "mcpServer/startupStatus/updated") {
      const params = event.notification.params;
      const name = typeof params.name === "string"
        ? params.name
        : typeof params.serverName === "string"
          ? params.serverName
          : undefined;
      const waiter = startupWaiterRef.current;
      if (
        !waiter
        || !name
        || name !== waiter.name
        || typeof params.threadId === "string"
        || (params.status !== "ready"
          && params.status !== "failed"
          && params.status !== "cancelled")
      ) {
        return;
      }
      window.clearTimeout(waiter.timer);
      startupWaiterRef.current = undefined;
      waiter.resolve({
        status: params.status,
        ...(typeof params.error === "string" ? { error: params.error } : {}),
      });
      return;
    }
    if (event.notification.method !== "mcpServer/oauthLogin/completed") {
      return;
    }
    const params = event.notification.params;
    const name = typeof params.name === "string"
      ? params.name
      : typeof params.serverName === "string"
        ? params.serverName
        : undefined;
    const pending = pendingActionRef.current;
    if (!name || pending?.kind !== "login" || name !== pending.name) {
      return;
    }
    if (params.success === true) {
      void finishLogin(name);
      return;
    }
    clearOAuthWaitTimer();
    setPendingAction(undefined);
    setNotice({
      kind: "error",
      text: typeof params.error === "string"
        ? params.error
        : `${name} login did not complete.`,
    });
  }), [
    clearOAuthWaitTimer,
    finishLogin,
    props.desktopApi,
    setPendingAction,
  ]);

  const reloadConfig = async () => {
    if (
      !props.desktopApi?.reloadCodexMcpServers
      || pendingActionRef.current
      || profileChanged
      || !activeCodexHome
    ) return;
    setPendingAction({ kind: "reload", name: "MCP configuration" });
    setNotice({ kind: "working", text: "Reloading MCP configuration..." });
    try {
      await props.desktopApi.reloadCodexMcpServers({
        codexHome: activeCodexHome,
      });
      if (await loadServers()) {
        setNotice({
          kind: "success",
          text: "MCP configuration reloaded. Loaded threads use it on their next turn.",
        });
      }
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(undefined);
    }
  };

  const relogin = async (server: CodexMcpServerSummary) => {
    if (
      !props.desktopApi?.startCodexMcpServerLogin
      || pendingActionRef.current
      || profileChanged
      || !activeCodexHome
    ) return;
    setPendingAction({ kind: "login", name: server.name });
    setNotice({
      kind: "working",
      text: `Waiting for ${server.name} login to complete...`,
    });
    scheduleLoginTimeout(server.name);
    try {
      const result = await props.desktopApi.startCodexMcpServerLogin({
        codexHome: activeCodexHome,
        name: server.name,
      });
      const pendingAfterStart = pendingActionRef.current as
        | PendingAction
        | undefined;
      if (
        pendingAfterStart?.kind !== "login"
        || pendingAfterStart.name !== server.name
      ) {
        return;
      }
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      clearOAuthWaitTimer();
      setPendingAction(undefined);
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const removeServer = async () => {
    const server = removeCandidate;
    if (
      !server
      || !props.desktopApi?.removeCodexMcpServer
      || pendingActionRef.current
      || profileChanged
      || !activeCodexHome
    ) return;
    setPendingAction({ kind: "remove", name: server.name });
    setNotice({ kind: "working", text: `Removing ${server.name}...` });
    try {
      await props.desktopApi.removeCodexMcpServer({
        codexHome: activeCodexHome,
        name: server.name,
      });
      setRemoveCandidate(undefined);
      if (await loadServers()) {
        setNotice({
          kind: "success",
          text: `${server.name} was removed from this Codex profile.`,
        });
      }
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(undefined);
    }
  };
  const actionsDisabled = Boolean(pendingAction)
    || profileChanged
    || !activeCodexHome;

  return (
    <SettingsSectionStack paneId="plugins" aria-label="Plugin settings">
      <SettingsPanelHead
        eyebrow="Plugins"
        title="Plugin connections"
        help="Inspect and repair the MCP servers configured for this PwrAgent profile's selected Codex profile."
        action={
          <button
            className="button button--secondary"
            disabled={loading || actionsDisabled}
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
          <span>Active Codex profile</span>
          <strong>{activeProfile?.displayName ?? "Default"}</strong>
          <code>{activeCodexHome ?? "Loading..."}</code>
        </div>
        {profileChanged ? (
          <p className="settings-plugin-notice settings-plugin-notice--error" role="alert">
            Codex profile selection changed to {selectedProfile?.displayName ?? "Default"}.
            Restart PwrAgent before managing MCP servers for that profile.
          </p>
        ) : null}
        {notice ? (
          <div
            className={`settings-plugin-notice settings-plugin-notice--${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <span>{notice.text}</span>
            {pendingAction?.kind === "login" ? (
              <button
                className="button button--ghost settings-plugin-notice__action"
                type="button"
                onClick={() => cancelLoginWait()}
              >
                Cancel login
              </button>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <p className="settings-empty">Loading MCP servers...</p>
        ) : servers.length ? (
          <div className="settings-mcp-list">
            {servers.map((server) => (
              <McpServerRow
                key={server.name}
                busy={pendingAction?.name === server.name}
                disabled={actionsDisabled}
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
                disabled={actionsDisabled}
                type="button"
                onClick={() => setRemoveCandidate(undefined)}
              >
                Cancel
              </button>
              <button
                className="button button--ghost settings-profile-row__button--danger"
                disabled={actionsDisabled}
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
  disabled: boolean;
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
            disabled={props.disabled}
            type="button"
            onClick={props.onRelogin}
          >
            {props.busy ? "Waiting..." : "Relogin"}
          </button>
        ) : null}
        <button
          className="button button--ghost settings-mcp-row__remove"
          disabled={props.disabled}
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
