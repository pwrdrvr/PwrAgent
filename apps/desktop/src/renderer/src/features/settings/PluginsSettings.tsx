import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CodexMcpServerSummary,
  DesktopSettingsSnapshot,
  McpConnectionStatus,
  ProbeMcpConnectionResponse,
  PwrSnapConnectionStatus,
  PwrGitConnectionStatus,
} from "@pwragent/shared";
import {
  describeMcpAuthStatus,
  resolveMcpConnectionSetup,
  summarizeMcpConnectionReadiness,
} from "@pwragent/shared";
import { McpInventoryLine } from "../../components/McpInventoryLine";
import {
  ChipContextMenu,
  type ChipContextMenuPosition,
} from "../chrome/ChipContextMenu";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import {
  countMcpServerHealth,
  describeMcpServerTools,
  readMcpServerHealth,
} from "./mcp-server-health";
import { SettingsSwitch } from "./SettingsSwitch";
import { sourceBadge } from "./settings-fields";


type ActionNotice = {
  kind: "error" | "info" | "success" | "working";
  text: string;
};

type PendingAction = {
  kind: "login" | "reload" | "remove";
  name: string;
};

type ConnectionPendingAction = {
  kind:
    | "authorize"
    | "availability"
    | "create"
    | "disconnect"
    | "probe"
    | "remove"
    | "update";
  connectionId?: string;
};

/** An in-place edit of a stored connection's name and endpoint. */
type ConnectionEditDraft = {
  connectionId: string;
  displayName: string;
  serverUrl: string;
  /**
   * What the row held when the dialog opened.
   *
   * Re-pointing discards credentials, so the dialog and the save notice both
   * say so -- but this has to be *compared*, not latched on the first
   * keystroke. A flag set in `onChange` stayed true after a character was
   * typed and deleted, and told the operator to re-authorize a connection
   * that was never touched.
   */
  originalServerUrl: string;
};

function editDraftRepointsServer(draft: ConnectionEditDraft): boolean {
  return draft.serverUrl.trim() !== draft.originalServerUrl.trim();
}

type StartupResult = {
  status: "ready" | "failed" | "cancelled";
  error?: string;
};

const LOGIN_STARTUP_WAIT_MS = 5_000;
const OAUTH_LOGIN_WAIT_MS = 120_000;
const TOOL_PREVIEW_LIMIT = 12;

function normalizeCodexHome(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/$/, "")
    .replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

/**
 * `~/.codex/profiles/work` is the form operators recognise. Only the
 * conventional `.codex` root is abbreviated; a `CODEX_HOME` pointed somewhere
 * else is shown in full rather than given a misleading `~`.
 */
function shortenCodexHome(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
  const match = /^.*?(\/\.codex(?:\/.*)?)$/.exec(normalized);
  return match ? `~${match[1]}` : normalized;
}

function readStartupStatus(
  value: unknown,
): NonNullable<CodexMcpServerSummary["startupStatus"]> | undefined {
  return value === "starting"
    || value === "ready"
    || value === "failed"
    || value === "cancelled"
    ? value
    : undefined;
}

function matchesMcpFilter(
  server: CodexMcpServerSummary,
  needle: string,
): boolean {
  return (
    server.name.toLowerCase().includes(needle)
    || server.tools.some((tool) => tool.toLowerCase().includes(needle))
  );
}

export function PluginsSettings(props: {
  desktopApi?: DesktopApi;
  saving?: boolean;
  snapshot: DesktopSettingsSnapshot;
  onMcpGatewayEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const [servers, setServers] = useState<CodexMcpServerSummary[]>([]);
  const [connections, setConnections] = useState<McpConnectionStatus[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionPending, setConnectionPending] =
    useState<ConnectionPendingAction>();
  const [connectionNotice, setConnectionNotice] = useState<ActionNotice>();
  const [connectionName, setConnectionName] = useState("");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [probe, setProbe] = useState<ProbeMcpConnectionResponse>();
  const [connectionEdit, setConnectionEdit] = useState<ConnectionEditDraft>();
  const [connectionRemoveCandidate, setConnectionRemoveCandidate] =
    useState<McpConnectionStatus>();
  const [activeCodexHome, setActiveCodexHome] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [expandedServers, setExpandedServers] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
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
  // A CODEX_HOME outside `<profile root>/<name>` matches no discovered
  // profile. Calling that "System default" would assert the store is
  // `~/.codex` when it demonstrably is not, so it is named for what it is.
  const activeProfileLabel = activeProfile?.displayName
    ?? (activeCodexHome ? "Custom CODEX_HOME" : "Loading...");
  // The System-default profile *is* `~/.codex`, so PwrAgent and a bare `codex`
  // share one store and there is no separation to warn about. Every other
  // home — a named profile or a custom CODEX_HOME — is fully isolated from it,
  // and an unrecognized home is exactly where the note matters most.
  const usesIsolatedCodexHome = Boolean(
    activeCodexHome && activeProfile?.name !== "",
  );
  const managedCodex = props.snapshot.runtime.tokenMiser?.managedCodex;

  const health = useMemo(() => countMcpServerHealth(servers), [servers]);
  const visibleServers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter((server) => matchesMcpFilter(server, needle));
  }, [filter, servers]);

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
      text: message ?? "Stopped waiting for sign-in. You can try again.",
    });
  }, [clearOAuthWaitTimer, setPendingAction]);

  const scheduleLoginTimeout = useCallback((name: string) => {
    clearOAuthWaitTimer();
    oauthWaitTimerRef.current = window.setTimeout(() => {
      if (
        pendingActionRef.current?.kind === "login"
        && pendingActionRef.current.name === name
      ) {
        cancelLoginWait(`${name} sign-in timed out. You can try again.`);
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
      // A name that vanished (removed here, or edited out of `config.toml`)
      // would otherwise sit in the expanded set forever and silently re-open
      // the drawer if that name ever came back.
      setExpandedServers((current) => {
        if (current.size === 0) return current;
        const live = new Set(response.servers.map((server) => server.name));
        const next = new Set<string>();
        for (const name of current) {
          if (live.has(name)) next.add(name);
        }
        return next.size === current.size ? current : next;
      });
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

  const gatewaySetting = props.snapshot.general.mcpGatewayEnabled;
  const gatewayEnabled = gatewaySetting.value;
  // Counts readiness, not the availability switch. The shipped chip read
  // "2 of 2 on" while one of the two held no credentials and could not serve
  // a single tool, because `enabled` defaults to true for a connection that
  // has never been authorized.
  const readiness = useMemo(
    () =>
      summarizeMcpConnectionReadiness(
        connections.map((connection) =>
          resolveMcpConnectionSetup({ connection, gatewayEnabled }),
        ),
      ),
    [connections, gatewayEnabled],
  );
  const readinessChip = connectionsLoading
    ? "Loading..."
    : readiness.total === 0
      ? "None yet"
      // The switch masks every per-connection state, so counting readiness
      // under it would report setup work whose only remedy is the switch.
      : readiness.gatewayOff === readiness.total
        ? "Gateway off"
        : [
            `${readiness.ready} ready`,
            ...(readiness.parked ? [`${readiness.parked} parked`] : []),
            ...(readiness.needsSetup
              ? [`${readiness.needsSetup} to set up`]
              : []),
          ].join(" · ");

  const loadConnections = useCallback(async () => {
    if (!props.desktopApi?.listMcpConnections) {
      setConnectionNotice({
        kind: "error",
        text: "PwrAgent-managed MCP connections are unavailable in this build.",
      });
      setConnectionsLoading(false);
      return false;
    }
    setConnectionsLoading(true);
    try {
      const response = await props.desktopApi.listMcpConnections();
      setConnections(response.connections);
      return true;
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setConnectionsLoading(false);
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void loadServers();
    void loadConnections();
  }, [loadConnections, loadServers]);

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
      text: `${name} sign-in completed. Reloading its MCP connection...`,
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
            ? `${name} signed in, but startup failed: ${startupResult.error}`
            : `${name} signed in, but its MCP connection failed to start.`,
        });
      } else if (startupResult?.status === "cancelled") {
        setNotice({
          kind: "error",
          text: `${name} signed in, but its MCP connection startup was cancelled.`,
        });
      } else {
        setNotice({
          kind: "success",
          text: `${name} signed in and its row was refreshed.`,
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
      const status = readStartupStatus(params.status);
      const isGlobalStatus = typeof params.threadId !== "string" && Boolean(status);
      // Keep every row's health current, not just the one an action is
      // waiting on. Without this the pane only ever learns a startup status
      // while a sign-in is in flight, so a server that died on launch is
      // indistinguishable from one that publishes no tools.
      if (name && status && isGlobalStatus) {
        const error = typeof params.error === "string" ? params.error : undefined;
        setServers((current) => {
          let changed = false;
          const next = current.map((server) => {
            if (server.name !== name) return server;
            if (server.startupStatus === status && server.startupError === error) {
              return server;
            }
            changed = true;
            const { startupError: _dropped, ...rest } = server;
            return {
              ...rest,
              startupStatus: status,
              ...(error ? { startupError: error } : {}),
            };
          });
          return changed ? next : current;
        });
      }
      const waiter = startupWaiterRef.current;
      // `starting` is the normal precursor to a terminal status and must leave
      // the waiter armed. Disarming on it would clear the fallback timer
      // without resolving, and `finishLogin` would await a promise that can
      // never settle — wedging the pane with its pending action forever.
      if (
        !waiter
        || !name
        || !status
        || status === "starting"
        || name !== waiter.name
        || !isGlobalStatus
      ) {
        return;
      }
      window.clearTimeout(waiter.timer);
      startupWaiterRef.current = undefined;
      waiter.resolve({
        status,
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
        : `${name} sign-in did not complete.`,
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

  const signIn = async (server: CodexMcpServerSummary) => {
    if (
      !props.desktopApi?.startCodexMcpServerLogin
      || pendingActionRef.current
      || profileChanged
      || !activeCodexHome
    ) return;
    setPendingAction({ kind: "login", name: server.name });
    setNotice({
      kind: "working",
      text: `Waiting for ${server.name} sign-in to complete...`,
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

  const toggleServer = (name: string) => {
    setExpandedServers((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };

  const authorizeConnection = async (
    connection: McpConnectionStatus,
    continueCreate = false,
  ) => {
    if (connectionPending && !continueCreate) return;
    setConnectionPending({
      kind: "authorize",
      connectionId: connection.id,
    });
    setConnectionNotice({
      kind: "working",
      text: `Waiting for ${connection.displayName} authorization to complete...`,
    });
    try {
      const connectLocal = connection.kind === "pwrgit"
        ? props.desktopApi?.connectPwrGit
        : connection.kind === "pwrsnap" ? props.desktopApi?.connectPwrSnap : undefined;
      if (connectLocal) {
        const response = await connectLocal();
        if (response.outcome !== "connected") {
          throw new Error(
            response.status.detail
            ?? `Open ${connection.displayName} and enable Local Agent Access, then try again.`,
          );
        }
      } else {
        if (!props.desktopApi?.authorizeMcpConnection) {
          throw new Error("MCP authorization is unavailable in this build.");
        }
        await props.desktopApi.authorizeMcpConnection({
          connectionId: connection.id,
        });
      }
      await loadConnections();
      setConnectionNotice({
        kind: "success",
        text: `${connection.displayName} is connected through PwrAgent.`,
      });
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setConnectionPending(undefined);
    }
  };

  /**
   * Check the endpoint before a record exists for it.
   *
   * `create` persists first and authorizes second, so a typo, a stdio
   * command line, or a bearer-token server each produced a saved row and a
   * raw OAuth error. Probing first means nothing is written until the screen
   * can say what it found.
   */
  const checkConnection = async () => {
    if (connectionPending || !props.desktopApi?.probeMcpConnection) return;
    setConnectionPending({ kind: "probe" });
    setConnectionNotice(undefined);
    try {
      const result = await props.desktopApi.probeMcpConnection({
        serverUrl: connectionUrl,
      });
      setProbe(result);
      if (result.ok && !connectionName.trim() && result.serverName) {
        setConnectionName(result.serverName);
      }
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setConnectionPending(undefined);
    }
  };

  const createConnection = async () => {
    if (connectionPending || !props.desktopApi?.createMcpConnection) return;
    if (!probe?.ok) {
      await checkConnection();
      return;
    }
    setConnectionPending({ kind: "create" });
    setConnectionNotice({
      kind: "working",
      text: `Adding ${connectionName.trim() || "MCP connection"}...`,
    });
    try {
      const response = await props.desktopApi.createMcpConnection({
        displayName: connectionName,
        // The probe resolves discovery redirects, so store what it reached
        // rather than what was typed.
        serverUrl: probe.serverUrl,
      });
      setConnectionName("");
      setConnectionUrl("");
      setProbe(undefined);
      await loadConnections();
      setConnectionPending(undefined);
      await authorizeConnection(response.connection, true);
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      setConnectionPending(undefined);
    }
  };

  const saveConnectionEdit = async () => {
    const draft = connectionEdit;
    if (!draft || connectionPending || !props.desktopApi?.updateMcpConnection) {
      return;
    }
    setConnectionPending({ kind: "update", connectionId: draft.connectionId });
    try {
      await props.desktopApi.updateMcpConnection({
        connectionId: draft.connectionId,
        displayName: draft.displayName,
        serverUrl: draft.serverUrl,
      });
      setConnectionEdit(undefined);
      await loadConnections();
      setConnectionNotice({
        kind: "success",
        // Re-pointing drops the credentials the old server issued, so say so
        // rather than letting the row look merely renamed.
        text: editDraftRepointsServer(draft)
          ? `${draft.displayName} now points at a different server. Authorize it again.`
          : `${draft.displayName} was updated.`,
      });
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setConnectionPending(undefined);
    }
  };

  const disconnectConnection = async (connection: McpConnectionStatus) => {
    if (connectionPending || !props.desktopApi?.disconnectMcpConnection) return;
    setConnectionPending({
      kind: "disconnect",
      connectionId: connection.id,
    });
    try {
      await props.desktopApi.disconnectMcpConnection({
        connectionId: connection.id,
      });
      await loadConnections();
      setConnectionNotice({
        kind: "success",
        text: `${connection.displayName} credentials were removed.`,
      });
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setConnectionPending(undefined);
    }
  };

  const setConnectionAvailability = async (
    connection: McpConnectionStatus,
    enabled: boolean,
  ) => {
    if (connectionPending || !props.desktopApi?.setMcpConnectionEnabled) return;
    setConnectionPending({ kind: "availability", connectionId: connection.id });
    try {
      await props.desktopApi.setMcpConnectionEnabled({
        connectionId: connection.id,
        enabled,
      });
      await loadConnections();
      setConnectionNotice({
        kind: "success",
        text: enabled
          ? `${connection.displayName} is available to threads again.`
          // Turning a connection off closes its live bridges, so say that
          // rather than letting a running thread look unaffected.
          : `${connection.displayName} was turned off. Threads already using it lose it on their next turn.`,
      });
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setConnectionPending(undefined);
    }
  };

  const removeConnection = async () => {
    const connection = connectionRemoveCandidate;
    if (
      !connection
      || connectionPending
      || !props.desktopApi?.removeMcpConnection
    ) return;
    setConnectionPending({ kind: "remove", connectionId: connection.id });
    try {
      await props.desktopApi.removeMcpConnection({
        connectionId: connection.id,
      });
      setConnectionRemoveCandidate(undefined);
      await loadConnections();
      setConnectionNotice({
        kind: "success",
        text: `${connection.displayName} was removed from this PwrAgent profile.`,
      });
    } catch (error) {
      setConnectionNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setConnectionPending(undefined);
    }
  };
  const actionsDisabled = Boolean(pendingAction)
    || profileChanged
    || !activeCodexHome;
  // `Reload config` also goes dim while a load is in flight or the pane is
  // scoped to a stale profile. A dim button with no stated reason reads as a
  // defect, so the reason travels with it.
  const reloadDisabledReason = profileChanged
    ? "Restart PwrAgent before managing MCP servers for the newly selected Codex profile."
    : !activeCodexHome
      ? "The active Codex profile is still loading."
      : pendingAction
        ? `Waiting for ${pendingAction.name}.`
        : undefined;

  return (
    <SettingsSectionStack paneId="plugins" aria-label="Plugin settings">
      <SettingsPanelHead
        eyebrow="Plugins"
        title="MCP connections"
        help="PwrAgent connections are held here and shared with every Codex and ACP thread you choose. The agent's own servers are configured inside Codex; PwrAgent only reports those."
        action={
          <button
            className="button button--secondary"
            disabled={loading || actionsDisabled}
            title={
              reloadDisabledReason
              ?? "Re-read installed MCP configuration and expose it to loaded Codex threads on their next turn."
            }
            type="button"
            onClick={() => void reloadConfig()}
          >
            Reload config
          </button>
        }
      />

      <SettingsSection
        eyebrow="PwrAgent gateway"
        title="PwrAgent connections"
        sectionId="managed-mcp-connections"
        description="PwrAgent keeps OAuth credentials encrypted in this profile, refreshes them centrally, and gives selected threads a local proxy instead of copying tokens into each agent process."
        chip={readinessChip}
        chipKind={readiness.ready === 0 && readiness.total > 0 ? "warn" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Managed MCP gateway"
            sub="Off means no thread can reach a managed connection, whatever each thread has selected. Credentials stay stored, so turning the gateway back on restores every selection."
            source={sourceBadge(gatewaySetting)}
            control={
              <SettingsSwitch
                checked={gatewayEnabled}
                disabled={props.saving}
                label="Managed MCP gateway"
                onChange={(next) => {
                  void props.onMcpGatewayEnabledChange(next);
                }}
              />
            }
          />
        </div>
        {connectionNotice ? (
          <div
            className={`settings-plugin-notice settings-plugin-notice--${connectionNotice.kind}`}
            role={connectionNotice.kind === "error" ? "alert" : "status"}
          >
            <span>{connectionNotice.text}</span>
          </div>
        ) : null}
        {/*
          * The constraint belongs above the fields. `authMode` is the literal
          * "oauth", so a command-line server — which is what most people mean
          * by "an MCP server" — can never be added here. Saying so first is
          * cheaper than a discovery failure after the record is written.
          */}
        <p className="settings-mcp-create__constraint">
          <strong>Remote MCP servers that sign in with OAuth.</strong>{" "}
          Command-line (stdio) servers belong in the agent&rsquo;s own config.
        </p>
        <form
          className="settings-mcp-create"
          onSubmit={(event) => {
            event.preventDefault();
            void createConnection();
          }}
        >
          <label>
            <span>Name</span>
            <input
              className="settings-input"
              disabled={Boolean(connectionPending)}
              placeholder="Datadog"
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
            />
          </label>
          <label>
            <span>Remote MCP URL</span>
            <input
              className="settings-input"
              disabled={Boolean(connectionPending)}
              inputMode="url"
              placeholder="https://mcp.example.com/mcp"
              value={connectionUrl}
              onChange={(event) => {
                setConnectionUrl(event.target.value);
                // A probe describes one URL. Keeping a stale verdict beside
                // an edited field would offer to save something that was
                // never checked.
                setProbe(undefined);
              }}
            />
          </label>
          <button
            className="button button--secondary"
            disabled={
              Boolean(connectionPending)
              || !connectionUrl.trim()
              || (probe?.ok === true && !connectionName.trim())
            }
            type="submit"
          >
            {connectionPending?.kind === "probe"
              ? "Checking..."
              : connectionPending?.kind === "create"
                ? "Adding..."
                : probe?.ok
                  ? "Add and authorize"
                  : "Check"}
          </button>
        </form>
        {probe ? (
          <p
            className={`settings-mcp-probe settings-mcp-probe--${
              probe.ok ? "ok" : "err"
            }`}
            role={probe.ok ? "status" : "alert"}
          >
            {probe.ok
              ? `Found ${probe.serverName ?? "an MCP server"} at ${probe.serverUrl}. It signs in with OAuth${
                  probe.toolCount === undefined
                    ? ""
                    : ` and offers ${probe.toolCount} tools`
                }. Nothing is saved yet.`
              : probe.message}
          </p>
        ) : null}
        {connectionsLoading ? (
          <p className="settings-empty">Loading connections...</p>
        ) : connections.length ? (
          <div className="settings-mcp-list">
            {connections.map((connection) => (
              <ManagedMcpConnectionRow
                key={connection.id}
                busy={connectionPending?.connectionId === connection.id}
                connection={connection}
                desktopApi={props.desktopApi}
                disabled={Boolean(connectionPending)}
                gatewayEnabled={gatewayEnabled}
                onAuthorize={() => void authorizeConnection(connection)}
                onAvailabilityChange={
                  props.desktopApi?.setMcpConnectionEnabled
                    ? (enabled) =>
                        void setConnectionAvailability(connection, enabled)
                    : undefined
                }
                onChanged={() => void loadConnections()}
                onDisconnect={() => void disconnectConnection(connection)}
                onEdit={() =>
                  setConnectionEdit({
                    connectionId: connection.id,
                    displayName: connection.displayName,
                    serverUrl: connection.serverUrl,
                    originalServerUrl: connection.serverUrl,
                  })
                }
                onNotice={setConnectionNotice}
                onRemove={() => setConnectionRemoveCandidate(connection)}
              />
            ))}
          </div>
        ) : (
          <p className="settings-empty">No PwrAgent connections yet.</p>
        )}
      </SettingsSection>

      <SettingsSection
        eyebrow="Codex only"
        title="The agent's own servers"
        sectionId="mcp-servers"
        description="Servers configured inside Codex itself, which PwrAgent reports but does not hold credentials for. Sign-in replaces expired OAuth credentials. Remove deletes only this server's configuration from the selected Codex profile."
        chip={
          loading
            ? "Loading..."
            : `${health.total} ${health.total === 1 ? "server" : "servers"} · ${health.tools} tools`
        }
        chipKind={
          health.failed > 0 ? "err" : health.needsSignIn > 0 ? "warn" : "default"
        }
      >
        <div className="settings-mcp-scope">
          <span className="settings-mcp-scope__key">Profile</span>
          <span className="settings-mcp-scope__value">
            <strong>{activeProfileLabel}</strong>
            <code>
              {activeCodexHome ? shortenCodexHome(activeCodexHome) : "Loading..."}
            </code>
          </span>
          <span className="settings-mcp-scope__key">Codex</span>
          <span className="settings-mcp-scope__value">
            <strong>
              {managedCodex?.state === "unavailable"
                ? "System Codex"
                : "PwrAgent managed"}
            </strong>
            {managedCodex?.version ? <code>{managedCodex.version}</code> : null}
            {managedCodex?.state === "ready" ? (
              <span className="settings-pathrow__chip settings-pathrow__chip--ok">
                Token Miser ready
              </span>
            ) : managedCodex?.state === "pending-switch" ? (
              <span className="settings-pathrow__chip">
                Token Miser pending restart
              </span>
            ) : null}
          </span>
          {usesIsolatedCodexHome ? (
            <p className="settings-mcp-scope__note">
              These servers and their sign-ins live in <strong>this profile only</strong>.
              PwrAgent's own terminals use it too; a <code>codex</code> you run outside
              PwrAgent falls back to <code>~/.codex</code> and has its own separate
              sign-ins.
            </p>
          ) : null}
        </div>
        {profileChanged ? (
          <p className="settings-plugin-notice settings-plugin-notice--error" role="alert">
            Codex profile selection changed to {selectedProfile?.displayName ?? "System default"}.
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
                Cancel sign-in
              </button>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <p className="settings-empty">Loading MCP servers...</p>
        ) : servers.length ? (
          <>
            <div className="settings-mcp-toolbar">
              <input
                className="settings-mcp-filter"
                aria-label="Filter MCP servers and tools"
                placeholder="Filter servers and tools..."
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <div className="settings-mcp-toolbar__counts">
                {health.ready > 0 ? (
                  <span className="settings-pathrow__chip settings-pathrow__chip--ok">
                    {health.ready} ready
                  </span>
                ) : null}
                {health.starting > 0 ? (
                  <span className="settings-pathrow__chip">
                    {health.starting} starting
                  </span>
                ) : null}
                {health.needsSignIn > 0 ? (
                  <span className="settings-pathrow__chip settings-pathrow__chip--warn">
                    {health.needsSignIn} need sign-in
                  </span>
                ) : null}
                {health.failed > 0 ? (
                  <span className="settings-pathrow__chip settings-pathrow__chip--err">
                    {health.failed} failed
                  </span>
                ) : null}
                {health.unknown > 0 ? (
                  <span className="settings-pathrow__chip">
                    {health.unknown} not reported
                  </span>
                ) : null}
              </div>
            </div>
            {visibleServers.length ? (
              <div className="settings-mcp-list">
                {visibleServers.map((server) => (
                  <McpServerRow
                    key={server.name}
                    busy={pendingAction?.name === server.name}
                    disabled={actionsDisabled}
                    expanded={expandedServers.has(server.name)}
                    server={server}
                    onSignIn={() => void signIn(server)}
                    onRemove={() => setRemoveCandidate(server)}
                    onToggle={() => toggleServer(server.name)}
                  />
                ))}
              </div>
            ) : (
              <p className="settings-empty">
                No MCP server or tool matches “{filter.trim()}”.
              </p>
            )}
          </>
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
                type="button"
                onClick={() => setRemoveCandidate(undefined)}
              >
                Cancel
              </button>
              <button
                className="button button--ghost settings-danger-button"
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

      {connectionEdit ? (
        <div className="settings-confirm-modal" role="presentation">
          <form
            aria-labelledby="edit-managed-mcp-heading"
            aria-modal="true"
            className="settings-confirm-dialog"
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void saveConnectionEdit();
            }}
          >
            <h2 id="edit-managed-mcp-heading">Edit connection</h2>
            <div className="settings-mcp-edit">
              <label>
                <span>Name</span>
                <input
                  className="settings-input"
                  disabled={Boolean(connectionPending)}
                  value={connectionEdit.displayName}
                  onChange={(event) =>
                    setConnectionEdit({
                      ...connectionEdit,
                      displayName: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>Remote MCP URL</span>
                <input
                  className="settings-input"
                  disabled={Boolean(connectionPending)}
                  inputMode="url"
                  value={connectionEdit.serverUrl}
                  onChange={(event) =>
                    setConnectionEdit({
                      ...connectionEdit,
                      serverUrl: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            {editDraftRepointsServer(connectionEdit) ? (
              <p>
                Changing the address discards the credentials the old server
                issued. You will need to authorize this connection again.
              </p>
            ) : null}
            <div className="settings-confirm-dialog__actions">
              <button
                className="button button--secondary"
                disabled={Boolean(connectionPending)}
                type="button"
                onClick={() => setConnectionEdit(undefined)}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                disabled={
                  Boolean(connectionPending)
                  || !connectionEdit.displayName.trim()
                  || !connectionEdit.serverUrl.trim()
                }
                type="submit"
              >
                {connectionPending?.kind === "update" ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {connectionRemoveCandidate ? (
        <div className="settings-confirm-modal" role="presentation">
          <div
            aria-labelledby="remove-managed-mcp-heading"
            aria-modal="true"
            className="settings-confirm-dialog settings-confirm-dialog--danger"
            role="dialog"
          >
            <h2 id="remove-managed-mcp-heading">Remove connection?</h2>
            <p>
              Remove <strong>{connectionRemoveCandidate.displayName}</strong> and
              its encrypted OAuth credentials from this PwrAgent profile.
              Threads selecting it will no longer receive the connection.
            </p>
            <div className="settings-confirm-dialog__actions">
              <button
                className="button button--secondary"
                disabled={Boolean(connectionPending)}
                type="button"
                onClick={() => setConnectionRemoveCandidate(undefined)}
              >
                Cancel
              </button>
              <button
                className="button button--ghost settings-profile-row__button--danger"
                disabled={Boolean(connectionPending)}
                type="button"
                onClick={() => void removeConnection()}
              >
                Remove connection
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsSectionStack>
  );
}

/**
 * Probe a local PwrSuite application.
 *
 * Both the row's state line and its actions need this: the line has to say
 * "Not running" rather than "Not connected" when the app simply is not up,
 * and the actions have to offer Open rather than Authorize. Installing the
 * app or turning on Local Agent Access happens outside this window, so the
 * probe re-runs whenever the operator comes back to it.
 */
function useLocalConnectionStatus(
  app: "PwrSnap" | "PwrGit" | undefined,
  desktopApi?: DesktopApi,
): {
  status: PwrSnapConnectionStatus | PwrGitConnectionStatus | undefined;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<
    PwrSnapConnectionStatus | PwrGitConnectionStatus
  >();
  const read = app === "PwrGit"
    ? desktopApi?.readPwrGitConnectionStatus
    : app === "PwrSnap" ? desktopApi?.readPwrSnapConnectionStatus : undefined;

  // Two probes can be in flight at once -- the mount read and a focus read,
  // or two focus reads from a quick alt-tab -- and they can resolve out of
  // order. Without a sequence number the older answer wins and the row
  // reports an app as not running after it started.
  const latestRead = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!read) return;
    const sequence = latestRead.current + 1;
    latestRead.current = sequence;
    try {
      const next = await read();
      if (latestRead.current === sequence) setStatus(next);
    } catch {
      // The row still resolves a state from the connection record, so a
      // failed probe degrades to the credential-only reading rather than
      // asserting the app is missing.
      if (latestRead.current === sequence) setStatus(undefined);
    }
  }, [read]);

  useEffect(() => {
    // A remote connection has nothing local to probe, so it registers no
    // listener at all rather than one that wakes for every window focus to
    // do nothing.
    if (!read) return;
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      // Anything still in flight belongs to a row that is going away.
      latestRead.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [read, refresh]);

  return { status, refresh };
}

/**
 * One connection, one claim.
 *
 * The shipped row rendered the credential state and the availability switch
 * as peers, so a never-authorized PwrSnap read `Not connected` beside an
 * `On` switch. `resolveMcpConnectionSetup` collapses that stack into a
 * single state, and the switch is withheld entirely until there is something
 * for it to be about.
 */
function ManagedMcpConnectionRow(props: {
  busy: boolean;
  connection: McpConnectionStatus;
  desktopApi?: DesktopApi;
  disabled: boolean;
  gatewayEnabled: boolean;
  onAuthorize: () => void;
  onAvailabilityChange?: (enabled: boolean) => void;
  onChanged: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onNotice: (notice: ActionNotice) => void;
  onRemove: () => void;
}) {
  const connection = props.connection;
  const app = connection.kind === "pwrgit"
    ? "PwrGit"
    : connection.kind === "pwrsnap" ? "PwrSnap" : undefined;
  const { status: localStatus, refresh: refreshLocal } =
    useLocalConnectionStatus(app, props.desktopApi);
  const setup = resolveMcpConnectionSetup({
    connection,
    gatewayEnabled: props.gatewayEnabled,
    ...(localStatus ? { localAvailability: localStatus.availability } : {}),
  });
  return (
    <article className="settings-mcp-row settings-mcp-row--managed">
      <div className="settings-mcp-row__body">
        <div className="settings-mcp-row__title">
          <strong>{connection.displayName}</strong>
          {/*
            * One chip, toned by the resolved state. The pair this replaced
            * could contradict itself — `Not connected` beside an `On` switch —
            * and a row carries its state better in color than in a sentence.
            */}
          <span
            className={`settings-pathrow__chip${
              setup.tone === "idle" ? "" : ` settings-pathrow__chip--${setup.tone}`
            }`}
          >
            {setup.headline}
          </span>
        </div>
        <span title={connection.serverUrl}>{connection.serverUrl}</span>
        <p className="settings-mcp-row__state">{setup.detail}</p>
      </div>
      <div className="settings-mcp-row__actions">
        {app ? (
          <LocalConnectionActions
            app={app}
            busy={props.busy}
            configured={connection.configured}
            desktopApi={props.desktopApi}
            disabled={props.disabled}
            status={localStatus}
            onAuthorize={props.onAuthorize}
            onChanged={() => {
              void refreshLocal();
              props.onChanged();
            }}
            onNotice={props.onNotice}
          />
        ) : (
          <button
            className="button button--secondary"
            disabled={props.disabled}
            type="button"
            onClick={props.onAuthorize}
          >
            {props.busy
              ? "Working..."
              : connection.configured ? "Reauthorize" : "Authorize"}
          </button>
        )}
        {connection.configured ? (
          <button
            className="button button--ghost"
            disabled={props.disabled}
            type="button"
            onClick={props.onDisconnect}
          >
            Disconnect
          </button>
        ) : null}
        {connection.kind === "remote" ? (
          <>
            {/*
              * A connection's URL is not a write-once field. `create`
              * persists before authorization is attempted, so without Edit a
              * single mistyped character left a dead row whose only exit was
              * Remove and retype.
              */}
            <button
              className="button button--ghost"
              disabled={props.disabled}
              type="button"
              onClick={props.onEdit}
            >
              Edit
            </button>
            <button
              className="button button--ghost settings-mcp-row__remove"
              disabled={props.disabled}
              type="button"
              onClick={props.onRemove}
            >
              Remove
            </button>
          </>
        ) : null}
      </div>
      {/*
        * The cell is always emitted, even when the switch is withheld. Each
        * row is its own grid, so an omitted child would let the remaining
        * columns resolve against that row's own content and leave the
        * switches at a different x on every row.
        */}
      <div className="settings-mcp-row__availability">
        {props.onAvailabilityChange && setup.offersAvailabilitySwitch ? (
          <>
            <SettingsSwitch
              checked={connection.enabled}
              // The gateway switch above already states the reason every
              // connection is off, and the row's own state line repeats it, so
              // this reads as a consequence rather than a dead control.
              disabled={props.disabled || !props.gatewayEnabled}
              label={`Offer ${connection.displayName} to threads`}
              onChange={props.onAvailabilityChange}
            />
            <span className="settings-mcp-row__availability-label">
              Offer to threads
            </span>
          </>
        ) : null}
      </div>

    </article>
  );
}

/**
 * A local application's setup ladder, one rung at a time.
 *
 * Each state offers exactly the action that advances it: a bare Authorize
 * before the app is installed and running with Local Agent Access would fail
 * with a connection error and name no cause. The probe itself lives in the
 * row, because the state line needs the same answer.
 */
function LocalConnectionActions(props: {
  app: "PwrSnap" | "PwrGit";
  busy: boolean;
  configured: boolean;
  desktopApi?: DesktopApi;
  disabled: boolean;
  status: PwrSnapConnectionStatus | PwrGitConnectionStatus | undefined;
  onAuthorize: () => void;
  onChanged: () => void;
  onNotice: (notice: ActionNotice) => void;
}) {
  const [pending, setPending] = useState(false);
  const desktopApi = props.desktopApi;
  const open = props.app === "PwrGit" ? desktopApi?.openPwrGit : desktopApi?.openPwrSnap;
  const download = props.app === "PwrGit"
    ? desktopApi?.openPwrGitDownload
    : desktopApi?.openPwrSnapDownload;
  const connect = props.app === "PwrGit" ? desktopApi?.connectPwrGit : desktopApi?.connectPwrSnap;

  // Every action here is invoked as `void run(...)`, so a rejection would
  // escape as an unhandled rejection and the button would simply revert —
  // indistinguishable from a click that did nothing. On a federated window
  // the pairing IPC always rejects, so that state would be permanent.
  const run = async (
    action: () => Promise<ActionNotice | undefined>,
  ): Promise<void> => {
    setPending(true);
    try {
      const notice = await action();
      props.onChanged();
      if (notice) props.onNotice(notice);
    } catch (cause) {
      props.onNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setPending(false);
    }
  };

  const busy = props.busy || pending;
  const status = props.status;
  const running = status?.availability === "running";
  const installed = status?.availability === "installed" || running;

  if (!status) {
    return (
      <button
        className="button button--secondary"
        disabled={props.disabled}
        type="button"
        onClick={props.onAuthorize}
      >
        {busy ? "Working..." : props.configured ? "Reauthorize" : "Authorize"}
      </button>
    );
  }

  if (!installed) {
    return (
      <button
        className="button button--secondary"
        disabled={busy}
        type="button"
        onClick={() => void run(async () => {
          const response = await download?.();
          if (response && !response.opened) {
            return {
              kind: "error",
              text:
                response.error
                ?? `PwrAgent could not open the ${props.app} download page.`,
            };
          }
          return undefined;
        })}
      >
        Get {props.app}
      </button>
    );
  }

  if (!running) {
    return (
      <button
        className="button button--secondary"
        disabled={busy}
        type="button"
        onClick={() => void run(async () => {
          const response = await open?.();
          if (response && !response.opened) {
            return {
              kind: "error",
              text: response.error ?? `PwrAgent could not open ${props.app}.`,
            };
          }
          return undefined;
        })}
      >
        Open {props.app}
      </button>
    );
  }

  if (!props.configured) {
    return (
      <button
        className="button button--secondary"
        disabled={busy}
        type="button"
        onClick={() => void run(async () => {
          const response = await connect?.();
          // A `needs_local_agent_access` result is not a failure and not a
          // success: the app is running but has not been told to accept
          // PwrAgent. Reporting it as connected would send the operator
          // looking for a bug instead of a setting.
          if (response?.outcome === "needs_local_agent_access") {
            return {
              kind: "info",
              text: `Turn on Local Agent Access in ${props.app}, then try Connect again.`,
            };
          }
          return undefined;
        })}
      >
        {busy ? "Connecting..." : "Connect"}
      </button>
    );
  }

  return (
    <button
      className="button button--secondary"
      disabled={props.disabled}
      type="button"
      onClick={props.onAuthorize}
    >
      {busy ? "Working..." : "Reauthorize"}
    </button>
  );
}

function McpServerRow(props: {
  busy: boolean;
  disabled: boolean;
  expanded: boolean;
  server: CodexMcpServerSummary;
  onRemove: () => void;
  onSignIn: () => void;
  onToggle: () => void;
}) {
  const server = props.server;
  const drawerId = useId();
  const [menuPosition, setMenuPosition] = useState<ChipContextMenuPosition>();
  const menuInvokerRef = useRef<HTMLButtonElement | null>(null);
  const health = readMcpServerHealth(server);
  const auth = describeMcpAuthStatus(server.authStatus);
  const canSignIn = auth.canSignIn;
  const openMenu = (event: { currentTarget: HTMLButtonElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    menuInvokerRef.current = event.currentTarget;
    setMenuPosition({ x: rect.left, y: rect.bottom + 4, anchorTop: rect.top });
  };

  return (
    <article className="settings-mcp-row" data-health={health}>
      <div className="settings-mcp-row__main">
        <button
          aria-controls={props.expanded ? drawerId : undefined}
          aria-expanded={props.expanded}
          className="settings-mcp-row__toggle"
          type="button"
          onClick={props.onToggle}
        >
          <span
            aria-hidden="true"
            className="settings-mcp-row__health"
          />
          <span aria-hidden="true" className="settings-mcp-row__chevron" />
          <span className="settings-mcp-row__name">{server.name}</span>
          <span className="settings-mcp-row__meta">
            {describeMcpServerTools(server, health)}
          </span>
        </button>
        <div className="settings-mcp-row__chips">
          <span
            className={`settings-pathrow__chip${
              auth.tone === "ok"
                ? " settings-pathrow__chip--ok"
                : auth.tone === "warn"
                  ? " settings-pathrow__chip--warn"
                  : ""
            }`}
            title={auth.description}
          >
            {auth.label}
          </span>
        </div>
        <div className="settings-mcp-row__actions">
          {health === "needsSignIn" ? (
            <button
              className="button button--secondary"
              disabled={props.disabled}
              type="button"
              onClick={props.onSignIn}
            >
              {props.busy ? "Waiting..." : "Sign in"}
            </button>
          ) : null}
          <button
            aria-expanded={Boolean(menuPosition)}
            aria-haspopup="menu"
            aria-label={`More actions for ${server.name}`}
            className="button button--ghost settings-mcp-row__more"
            disabled={props.disabled}
            title={`More actions for ${server.name}`}
            type="button"
            onClick={openMenu}
          >
            <span aria-hidden="true">···</span>
          </button>
        </div>
      </div>
      {server.startupError ? (
        <p className="settings-mcp-row__error">{server.startupError}</p>
      ) : health === "needsSignIn" ? (
        <p className="settings-mcp-row__error">
          Sign in to load this server's tools.
        </p>
      ) : null}
      {props.expanded ? (
        <div className="settings-mcp-row__drawer" id={drawerId}>
          <McpInventoryLine
            className="settings-mcp-row__tools"
            label="Tools"
            previewLimit={TOOL_PREVIEW_LIMIT}
            values={server.tools}
          />
        </div>
      ) : null}
      {menuPosition && menuInvokerRef.current ? (
        <ChipContextMenu
          className="settings-mcp-context-menu"
          items={[
            ...(canSignIn
              ? [{
                  label: health === "needsSignIn"
                    ? `Sign in to ${server.name}`
                    : `Sign in to ${server.name} again`,
                  action: props.onSignIn,
                }]
              : []),
            {
              label: `Remove ${server.name}`,
              action: props.onRemove,
              separated: canSignIn,
            },
          ]}
          position={menuPosition}
          returnFocusTo={menuInvokerRef.current}
          onClose={() => setMenuPosition(undefined)}
        />
      ) : null}
    </article>
  );
}

