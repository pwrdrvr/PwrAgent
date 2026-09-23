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
  McpConnectionSetupState,
  McpConnectionStatus,
  ProbeMcpConnectionResponse,
  PwrSnapConnectionStatus,
  PwrGitConnectionStatus,
} from "@pwragent/shared";
import {
  describeMcpAuthStatus,
  describeMcpConnectionAuth,
  mcpConnectionIdsForNewThread,
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
  SettingsPendingIndicator,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import {
  countMcpServerHealth,
  describeManagedMcpConnectionTools,
  describeMcpServerTools,
  readManagedMcpConnectionHealth,
  readMcpServerHealth,
  type ManagedMcpToolInventory,
} from "./mcp-server-health";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsSwitch } from "./SettingsSwitch";
import { sourceBadge } from "./settings-fields";


type ActionNotice = {
  kind: "error" | "info" | "success" | "working";
  text: string;
};

type PendingAction = {
  kind: "reload" | "remove";
  name: string;
};

/**
 * Where a Codex server's sign-in is: waiting on the browser, or signed in and
 * waiting for Codex to restart the server with the new credentials.
 */
type CodexSignInPhase = "browser" | "starting";

type ConnectionPendingAction = {
  kind:
    | "availability"
    | "create"
    | "disconnect"
    | "newThreadDefault"
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

/** Take one from `key`'s count, dropping the key at zero. Returns the count before. */
function releaseCount(counts: Map<string, number>, key: string): number {
  const count = counts.get(key) ?? 0;
  if (count > 1) counts.set(key, count - 1);
  else counts.delete(key);
  return count;
}

/** `current` with `key` set to `message`, or without `key` when there is none. */
function withKeyedMessage(
  current: Readonly<Record<string, string>>,
  key: string,
  message?: string,
): Readonly<Record<string, string>> {
  if (message !== undefined) return { ...current, [key]: message };
  if (!(key in current)) return current;
  const { [key]: _cleared, ...rest } = current;
  return rest;
}

/**
 * The pane's two sections, by the ids the Settings nav deep-links to. Shared
 * so the nav child and the section it scrolls to cannot drift apart.
 */
export const PLUGINS_MCP_GATEWAY_SECTION_ID = "managed-mcp-connections";
export const PLUGINS_CODEX_MCP_SECTION_ID = "mcp-servers";

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
  /** Section the Settings nav asked to open, by `sectionId`. */
  focusSectionId?: string;
  saving?: boolean;
  snapshot: DesktopSettingsSnapshot;
  onMcpGatewayEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const [servers, setServers] = useState<CodexMcpServerSummary[]>([]);
  const [connections, setConnections] = useState<McpConnectionStatus[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionPending, setConnectionPendingState] =
    useState<ConnectionPendingAction>();
  /**
   * The live `connectionPending`, for a handler that has to refuse a second
   * click in the same tick: React has not flushed the first one's state yet.
   */
  const connectionPendingRef = useRef<ConnectionPendingAction | undefined>(
    undefined,
  );
  const setConnectionPending = useCallback(
    (action?: ConnectionPendingAction) => {
      connectionPendingRef.current = action;
      setConnectionPendingState(action);
    },
    [],
  );
  /**
   * The sign-ins in flight, by connection, each holding the attempt that
   * started it.
   *
   * Kept apart from `connectionPending` on purpose. Everything that sets that
   * one is a main-process round trip that settles in well under a second; a
   * sign-in waits on a browser for as long as the operator takes. It used to
   * hold the same latch, so one sign-in disabled every button on every row
   * and the add form, and the only way out was a banner at the top of the
   * card. Nothing required that: each attempt binds its own callback port and
   * the gateway tracks attempts per connection.
   *
   * Cancel sign-in removes the attempt, so a browser round trip the operator
   * has walked away from lands on a stale attempt when it settles and cannot
   * report on the row -- or put it back into the wait it was released from.
   */
  const authorizationsRef = useRef(new Map<string, number>());
  const authorizationAttemptRef = useRef(0);
  const [authorizing, setAuthorizing] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const publishAuthorizing = useCallback(() => {
    setAuthorizing(new Set(authorizationsRef.current.keys()));
  }, []);
  /** Why each connection's last sign-in failed, shown on its own row. */
  const [authorizationErrors, setAuthorizationErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const setAuthorizationError = useCallback(
    (connectionId: string, error?: string) => {
      setAuthorizationErrors((current) =>
        withKeyedMessage(current, connectionId, error),
      );
    },
    [],
  );
  // Counts completed sign-ins per connection. A reauthorization can switch
  // accounts without changing anything else the row can see, so the row
  // re-reads its tools when this moves.
  const [signIns, setSignIns] = useState<Record<string, number>>({});
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
  /**
   * The Codex sign-ins in flight, by server name.
   *
   * These used to share `pendingAction` with Reload config and Remove, so one
   * sign-in disabled every row in the card for as long as the browser took,
   * with its Cancel in a banner at the top. Codex runs each
   * `mcpServer/oauth/login` on its own and reports it by name, so they can
   * wait side by side, each on its own row.
   */
  const codexSignInsRef = useRef(new Map<string, {
    attempt: number;
    phase: CodexSignInPhase;
    timer?: number;
  }>());
  const codexSignInAttemptRef = useRef(0);
  const [codexSignIns, setCodexSignIns] = useState<
    Readonly<Record<string, CodexSignInPhase>>
  >({});
  const publishCodexSignIns = useCallback(() => {
    setCodexSignIns(Object.fromEntries(
      [...codexSignInsRef.current].map(([name, entry]) => [name, entry.phase]),
    ));
  }, []);
  /**
   * Codex logins started for each server that have not reported back yet,
   * counting any the operator has since called off.
   *
   * `mcpServer/oauthLogin/completed` names the server and nothing else. There
   * is no cancel request either, so a called-off login keeps running until
   * Codex times it out -- and its failure is indistinguishable from the retry
   * the row is waiting on. Only the count can tell them apart.
   */
  const codexLoginsOutstandingRef = useRef(new Map<string, number>());
  /** Why each Codex server's last sign-in failed, shown on its own row. */
  const [codexSignInErrors, setCodexSignInErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const setCodexSignInError = useCallback((name: string, error?: string) => {
    setCodexSignInErrors((current) => withKeyedMessage(current, name, error));
  }, []);
  /** Per server, a `finishLogin` waiting for Codex to report it started. */
  const startupWaitersRef = useRef(new Map<string, {
    resolve: () => void;
    timer: number;
  }>());
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

  const endCodexSignIn = useCallback((name: string) => {
    const entry = codexSignInsRef.current.get(name);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    codexSignInsRef.current.delete(name);
    publishCodexSignIns();
  }, [publishCodexSignIns]);

  /**
   * Stop waiting on a Codex sign-in that is still in the browser. Codex has no
   * request to call the login off, so this only releases the row; the login's
   * eventual report is counted out in `codexLoginsOutstandingRef`.
   */
  const cancelCodexSignIn = useCallback((name: string) => {
    if (codexSignInsRef.current.get(name)?.phase !== "browser") return;
    endCodexSignIn(name);
  }, [endCodexSignIn]);

  const cancelStartupWait = useCallback((name: string) => {
    const waiter = startupWaitersRef.current.get(name);
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    startupWaitersRef.current.delete(name);
    waiter.resolve();
  }, []);

  const waitForGlobalStartup = useCallback((name: string) => {
    cancelStartupWait(name);
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        if (startupWaitersRef.current.get(name)?.timer === timer) {
          startupWaitersRef.current.delete(name);
        }
        resolve();
      }, LOGIN_STARTUP_WAIT_MS);
      startupWaitersRef.current.set(name, { resolve, timer });
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
    // `loading` starts true and is never raised again, for the reason
    // `loadConnections` gives: a refresh after one row's sign-in must not
    // remount a row that is still waiting on its own.
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
    // `connectionsLoading` starts true and is never raised again. Raising it
    // on a refresh swapped the whole list for "Loading connections..." after
    // every action, which remounted each row -- closing its drawer and, now
    // that sign-ins run side by side, restarting another row's wait.
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

  useEffect(() => {
    const signIns = codexSignInsRef.current;
    const waiters = startupWaitersRef.current;
    return () => {
      for (const entry of signIns.values()) window.clearTimeout(entry.timer);
      for (const waiter of waiters.values()) window.clearTimeout(waiter.timer);
      waiters.clear();
    };
  }, []);

  /**
   * A Codex server signed in: reload Codex's MCP configuration so the server
   * restarts with the new credentials, then refresh the list. The row shows
   * this as its `starting` phase.
   *
   * How the start went is the row's own health line -- the refreshed list
   * carries the startup status and its error -- so only a reload that could
   * not happen is written here. A success needs no words: the row turns to
   * `Signed in` and lists its tools.
   */
  const finishLogin = useCallback(async (name: string, attempt: number) => {
    const entry = codexSignInsRef.current.get(name);
    if (entry?.attempt !== attempt) return;
    window.clearTimeout(entry.timer);
    codexSignInsRef.current.set(name, { attempt, phase: "starting" });
    publishCodexSignIns();
    const isCurrent = () =>
      codexSignInsRef.current.get(name)?.attempt === attempt;
    const fail = (message: string) => {
      if (!isCurrent()) return;
      endCodexSignIn(name);
      setCodexSignInError(name, message);
    };
    const codexHome = activeCodexHome;
    if (!props.desktopApi?.reloadCodexMcpServers) {
      fail("Signed in, but this build cannot reload MCP configuration.");
      return;
    }
    if (!codexHome) {
      fail("Signed in, but the active Codex profile is unavailable.");
      return;
    }
    const startup = waitForGlobalStartup(name);
    try {
      await props.desktopApi.reloadCodexMcpServers({ codexHome });
      await startup;
      await loadServers();
      if (isCurrent()) endCodexSignIn(name);
    } catch (error) {
      cancelStartupWait(name);
      fail(
        "Signed in, but reloading MCP configuration failed: "
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }, [
    activeCodexHome,
    cancelStartupWait,
    endCodexSignIn,
    loadServers,
    props.desktopApi,
    publishCodexSignIns,
    setCodexSignInError,
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
      // `starting` is the normal precursor to a terminal status and must leave
      // the waiter armed. Disarming on it would clear the fallback timer
      // without resolving, and `finishLogin` would await a promise that can
      // never settle — wedging the row in its wait forever.
      if (!name || !status || status === "starting" || !isGlobalStatus) {
        return;
      }
      const waiter = startupWaitersRef.current.get(name);
      if (!waiter) return;
      window.clearTimeout(waiter.timer);
      startupWaitersRef.current.delete(name);
      waiter.resolve();
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
    if (!name) return;
    // Every report closes one login Codex was running for this server,
    // whether or not a row is still waiting on it.
    const outstanding = releaseCount(codexLoginsOutstandingRef.current, name);
    const entry = codexSignInsRef.current.get(name);
    if (entry?.phase !== "browser") return;
    // Codex saved the credentials, whichever login it was.
    if (params.success === true) {
      void finishLogin(name, entry.attempt);
      return;
    }
    // A login the operator called off started before the one the row waits
    // on, and Codex gives each the same timeout, so while an older one is
    // outstanding a failure is taken to be its. Getting that wrong keeps the
    // row waiting a little longer; the other way round ended a live sign-in
    // and blamed it for a failure it never had.
    if (outstanding > 1) return;
    endCodexSignIn(name);
    setCodexSignInError(
      name,
      typeof params.error === "string"
        ? `Sign-in failed: ${params.error}`
        : "Sign-in did not complete.",
    );
  }), [
    endCodexSignIn,
    finishLogin,
    props.desktopApi,
    setCodexSignInError,
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
    const name = server.name;
    const codexHome = activeCodexHome;
    if (
      !props.desktopApi?.startCodexMcpServerLogin
      || codexSignInsRef.current.has(name)
      || pendingActionRef.current
      || profileChanged
      || !codexHome
    ) return;
    codexSignInAttemptRef.current += 1;
    const attempt = codexSignInAttemptRef.current;
    const isCurrent = () =>
      codexSignInsRef.current.get(name)?.attempt === attempt;
    const timer = window.setTimeout(() => {
      if (!isCurrent()) return;
      endCodexSignIn(name);
      setCodexSignInError(name, "Sign-in timed out. You can try again.");
    }, OAUTH_LOGIN_WAIT_MS);
    codexSignInsRef.current.set(name, { attempt, phase: "browser", timer });
    publishCodexSignIns();
    setCodexSignInError(name);
    // Counted before the request, so a called-off login that reports while
    // this one is still being started is not mistaken for this one.
    const outstanding = codexLoginsOutstandingRef.current;
    outstanding.set(name, (outstanding.get(name) ?? 0) + 1);
    try {
      const result = await props.desktopApi.startCodexMcpServerLogin({
        codexHome,
        name,
      });
      // Called off before the link arrived: there is nothing to open.
      if (!isCurrent()) return;
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      // No login started, so none will report.
      releaseCount(outstanding, name);
      if (!isCurrent()) return;
      endCodexSignIn(name);
      setCodexSignInError(
        name,
        `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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

  /**
   * Give up on a sign-in that left for the browser and never came back.
   *
   * There is nothing here to abort: the round trip belongs to the browser and
   * to the callback listener in the main process, which gives up on its own
   * after five minutes. What the operator is stuck behind is the row's wait,
   * which stands in for its Authorize, Edit, and Remove -- including the
   * Authorize that would issue a fresh link. So this drops the attempt, and
   * the abandoned one lands on a stale attempt and says nothing.
   *
   * The main process is told as well, so the abandoned listener stops holding
   * its port and a retry starts from a clean callback rather than racing the
   * one the operator walked away from.
   */
  const cancelAuthorization = async (connection: McpConnectionStatus) => {
    if (!authorizationsRef.current.delete(connection.id)) return;
    publishAuthorizing();
    try {
      await props.desktopApi?.cancelMcpConnectionAuthorization?.({
        connectionId: connection.id,
      });
    } catch {
      // Releasing the row is the whole point, and it already happened. A
      // listener that outlives this call times out on its own.
    }
    await loadConnections();
  };

  /**
   * Sign a connection in, on its own row.
   *
   * The wait and its outcome both belong to the row that asked: the row shows
   * the wait with its Cancel beside it, and a failure is written under the
   * row. A success needs no words -- the row turns to `Signed in` and lists
   * its tools -- and announcing it in the card's notice would push every row
   * down at the moment the operator is reading one of them.
   */
  const authorizeConnection = async (
    connection: McpConnectionStatus,
    continueCreate = false,
  ) => {
    // The refs, not the state: two clicks in one tick both read state that
    // React has not flushed yet, and both start a browser round trip.
    if (
      authorizationsRef.current.has(connection.id)
      || (connectionPendingRef.current && !continueCreate)
    ) return;
    authorizationAttemptRef.current += 1;
    const attempt = authorizationAttemptRef.current;
    const isCurrent = () =>
      authorizationsRef.current.get(connection.id) === attempt;
    authorizationsRef.current.set(connection.id, attempt);
    publishAuthorizing();
    setAuthorizationError(connection.id);
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
      if (!isCurrent()) return;
      setSignIns((current) => ({
        ...current,
        [connection.id]: (current[connection.id] ?? 0) + 1,
      }));
    } catch (error) {
      if (!isCurrent()) return;
      setAuthorizationError(
        connection.id,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (isCurrent()) {
        authorizationsRef.current.delete(connection.id);
        publishAuthorizing();
      }
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
      // The new row carries the sign-in from here, so "Adding..." is done.
      setConnectionNotice(undefined);
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
      // A failed sign-in describes the server it was attempted against.
      if (editDraftRepointsServer(draft)) {
        setAuthorizationError(draft.connectionId);
      }
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

  const setConnectionSelectForNewThreads = async (
    connection: McpConnectionStatus,
    selectForNewThreads: boolean,
  ) => {
    if (
      connectionPending
      || !props.desktopApi?.setMcpConnectionSelectForNewThreads
    ) return;
    setConnectionPending({
      kind: "newThreadDefault",
      connectionId: connection.id,
    });
    try {
      await props.desktopApi.setMcpConnectionSelectForNewThreads({
        connectionId: connection.id,
        selectForNewThreads,
      });
      await loadConnections();
      setConnectionNotice({
        kind: "success",
        // Both halves of "new threads only" are worth saying: a thread that
        // exists already does not suddenly gain a server, and one that is
        // about to be started does not lose one the operator picked.
        text: selectForNewThreads
          ? `New threads start with ${connection.displayName} selected. Existing threads are unchanged.`
          : `New threads start without ${connection.displayName}. Existing threads are unchanged.`,
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
    <SettingsSectionStack
      paneId="plugins"
      aria-label="Plugin settings"
      focusSectionId={props.focusSectionId}
    >
      <SettingsPanelHead
        eyebrow="Plugins"
        title="MCP connections"
        help="PwrAgent-managed connections are held here and shared with every Codex and ACP thread you choose. Codex-managed servers are configured inside Codex itself; PwrAgent only reports those."
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
        title="PwrAgent-managed connections"
        sectionId={PLUGINS_MCP_GATEWAY_SECTION_ID}
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
        <div className="settings-mcp-manage">
          {connectionNotice ? (
            <div
              className={`settings-plugin-notice settings-plugin-notice--${connectionNotice.kind}`}
              role={connectionNotice.kind === "error" ? "alert" : "status"}
            >
              <span>{connectionNotice.text}</span>
            </div>
          ) : null}
          {/*
            * The inventory first, then the slot to add to it.
            *
            * Both used to render as bare children of the card body at the
            * same weight, with the empty add fields directly above the rows,
            * so the form read as a fourth connection that had lost its name.
            * The rows are what the operator came to manage; `--create` is
            * dashed and unfilled because it is the one block here that is not
            * yet a thing.
            */}
          {connectionsLoading ? (
            <p className="settings-empty">Loading connections...</p>
          ) : connections.length ? (
            <div className="settings-mcp-list">
              {connections.map((connection) => (
                <ManagedMcpConnectionRow
                  key={connection.id}
                  authorizationError={authorizationErrors[connection.id]}
                  authorizing={authorizing.has(connection.id)}
                  busy={connectionPending?.connectionId === connection.id}
                  connection={connection}
                  desktopApi={props.desktopApi}
                  disabled={Boolean(connectionPending)}
                  gatewayEnabled={gatewayEnabled}
                  signIns={signIns[connection.id] ?? 0}
                  onAuthorize={() => void authorizeConnection(connection)}
                  onCancelAuthorization={() => void cancelAuthorization(connection)}
                  onAvailabilityChange={
                    props.desktopApi?.setMcpConnectionEnabled
                      ? (enabled) =>
                          void setConnectionAvailability(connection, enabled)
                      : undefined
                  }
                  onSelectForNewThreadsChange={
                    props.desktopApi?.setMcpConnectionSelectForNewThreads
                      ? (selectForNewThreads) =>
                          void setConnectionSelectForNewThreads(
                            connection,
                            selectForNewThreads,
                          )
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
          <form
            className="settings-mcp-create"
            onSubmit={(event) => {
              event.preventDefault();
              void createConnection();
            }}
          >
            <h3 className="settings-mcp-create__title">Add a remote MCP server</h3>
            {/*
              * The constraint belongs above the fields. `authMode` is the
              * literal "oauth", so a command-line server -- which is what most
              * people mean by "an MCP server" -- can never be added here.
              * Saying so first is cheaper than a discovery failure after the
              * record is written.
              */}
            <p className="settings-mcp-create__constraint">
              It has to be a remote server that signs in with OAuth.
              Command-line (stdio) servers belong in the agent&rsquo;s own
              configuration file.
            </p>
            <div className="settings-mcp-create__fields">
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
            </div>
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
          </form>
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Codex only"
        title="Codex-managed servers"
        sectionId={PLUGINS_CODEX_MCP_SECTION_ID}
        description="Codex reads these from its own configuration file and holds their credentials itself; PwrAgent reports them but cannot offer them to an ACP thread. Sign-in replaces expired OAuth credentials. Remove deletes only this server's configuration from the selected Codex profile."
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
                    disabled={actionsDisabled}
                    expanded={expandedServers.has(server.name)}
                    server={server}
                    signIn={codexSignIns[server.name]}
                    signInError={codexSignInErrors[server.name]}
                    onCancelSignIn={() => cancelCodexSignIn(server.name)}
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
 * Setup states the row names with a chip of their own.
 *
 * The auth chip and the health dot carry the credential and the server's
 * answer, in the same vocabulary as the Codex list below. What they cannot
 * say is why a signed-in connection still reaches no thread -- the gateway is
 * off, the app is not installed or not running, or the operator parked it --
 * so those states keep the headline `resolveMcpConnectionSetup` gives them.
 */
const AVAILABILITY_CHIP_STATES: ReadonlySet<McpConnectionSetupState> = new Set([
  "gateway_off",
  "app_not_installed",
  "app_not_running",
  "parked",
]);

function chipToneClass(tone: "ok" | "warn" | "err" | "idle" | "neutral"): string {
  return tone === "idle" || tone === "neutral"
    ? ""
    : ` settings-pathrow__chip--${tone}`;
}

/**
 * Read a managed connection's tools while its row is on screen.
 *
 * Only a connection that can answer is asked: one that is signed in and
 * either offered or parked. Anything else already has a reason on the row,
 * and a request would only fail with that reason restated. `identity`
 * changes when the server or the credentials might have, which is when a
 * list read earlier stops describing this row.
 */
function useManagedConnectionTools(params: {
  connectionId: string;
  desktopApi?: DesktopApi;
  identity: string;
  listable: boolean;
  /** Completed sign-ins; a change forces a fresh read past any cache. */
  signIns: number;
}): {
  inventory: ManagedMcpToolInventory | undefined;
  refresh: () => void;
} {
  const { connectionId, identity, listable, signIns } = params;
  const list = params.desktopApi?.listMcpConnectionTools;
  const [inventory, setInventory] = useState<ManagedMcpToolInventory>();
  // A refresh can overtake the read the row started on mount, and the two can
  // resolve in either order. The later request is the one the operator asked
  // for, so an earlier answer arriving second is dropped.
  const latestRead = useRef(0);
  // PwrSnap and PwrGit connect outside the gateway's own authorization, so
  // the main process may still hold the list the old credentials read. The
  // read after a sign-in skips that cache; later re-reads use it again.
  const readSignIns = useRef(signIns);

  const read = useCallback(async (refresh: boolean): Promise<void> => {
    if (!list) return;
    const sequence = latestRead.current + 1;
    latestRead.current = sequence;
    setInventory({ status: "loading" });
    try {
      const response = await list({
        connectionId,
        ...(refresh ? { refresh: true } : {}),
      });
      if (latestRead.current !== sequence) return;
      setInventory({
        status: "loaded",
        tools: response.tools,
        fetchedAt: response.fetchedAt,
      });
    } catch (cause) {
      if (latestRead.current !== sequence) return;
      setInventory({
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [connectionId, list]);

  useEffect(() => {
    if (!listable || !list) {
      latestRead.current += 1;
      setInventory(listable ? { status: "unavailable" } : undefined);
      return;
    }
    const signedInAgain = readSignIns.current !== signIns;
    readSignIns.current = signIns;
    void read(signedInAgain);
    return () => {
      latestRead.current += 1;
    };
  }, [identity, list, listable, read, signIns]);

  return {
    inventory,
    refresh: () => {
      void read(true);
    },
  };
}

/**
 * One managed connection, told in the Codex list's vocabulary.
 *
 * It used to be a name, a URL, and one chip resolved from the whole setup
 * stack, beside a Codex list that showed every server's health, its sign-in
 * state, and every tool it publishes. The row now carries the same three
 * things the same way -- the health dot, the tool line, and the auth chip
 * come from the helpers the Codex row uses -- and keeps what only a managed
 * connection has: the setup remedy, its actions, and the two switches.
 */
function ManagedMcpConnectionRow(props: {
  /** Why this connection's last sign-in failed, until it is tried again. */
  authorizationError?: string;
  /** A sign-in for this connection is waiting on the browser. */
  authorizing: boolean;
  busy: boolean;
  connection: McpConnectionStatus;
  desktopApi?: DesktopApi;
  disabled: boolean;
  gatewayEnabled: boolean;
  /** Completed sign-ins for this connection in this pane. */
  signIns: number;
  onAuthorize: () => void;
  onCancelAuthorization: () => void;
  onAvailabilityChange?: (enabled: boolean) => void;
  onSelectForNewThreadsChange?: (selectForNewThreads: boolean) => void;
  onChanged: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onNotice: (notice: ActionNotice) => void;
  onRemove: () => void;
}) {
  const connection = props.connection;
  const drawerId = useId();
  const [expanded, setExpanded] = useState(false);
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
  const listable = setup.state === "ready" || setup.state === "parked";
  const { inventory, refresh: refreshTools } = useManagedConnectionTools({
    connectionId: connection.id,
    desktopApi: props.desktopApi,
    identity: `${connection.serverUrl}\n${connection.configured}`,
    listable,
    signIns: props.signIns,
  });
  const health = readManagedMcpConnectionHealth(setup, inventory);
  const auth = describeMcpConnectionAuth(connection);
  // An app that is missing or not running has nothing to sign in to yet: its
  // Get/Open action is the next step, and `Sign-in required` beside it would
  // point at the wrong one. Credentials held from before still say something.
  const showAuthChip =
    connection.configured
    || (setup.state !== "app_not_installed" && setup.state !== "app_not_running");
  const selectedForNewThreads =
    connection.enabled && connection.selectForNewThreads === true;
  // Whether seeding would take it today, asked of the same predicate the
  // seeding uses, so the hint cannot promise a thread something it skips.
  const seedable =
    mcpConnectionIdsForNewThread([{ ...connection, selectForNewThreads: true }])
      .length > 0;
  // A sign-in in flight holds this row only. Its switches wait for it, since
  // it replaces the credentials they describe; every other row stays live.
  const disabled = props.disabled || props.authorizing;
  return (
    <article
      className="settings-mcp-row settings-mcp-row--managed"
      data-health={health}
    >
      <div className="settings-mcp-row__main">
        <button
          aria-controls={expanded ? drawerId : undefined}
          aria-expanded={expanded}
          className="settings-mcp-row__toggle"
          type="button"
          onClick={() => setExpanded((current) => !current)}
        >
          <span aria-hidden="true" className="settings-mcp-row__health" />
          <span aria-hidden="true" className="settings-mcp-row__chevron" />
          <span className="settings-mcp-row__name">
            {connection.displayName}
          </span>
          <span className="settings-mcp-row__meta">
            {describeManagedMcpConnectionTools(setup, inventory)}
          </span>
        </button>
        <div className="settings-mcp-row__chips">
          {AVAILABILITY_CHIP_STATES.has(setup.state) ? (
            <span className={`settings-pathrow__chip${chipToneClass(setup.tone)}`}>
              {setup.headline}
            </span>
          ) : null}
          {showAuthChip ? (
            <span
              className={`settings-pathrow__chip${chipToneClass(auth.tone)}`}
              title={auth.description}
            >
              {auth.label}
            </span>
          ) : null}
        </div>
        <div className="settings-mcp-row__actions">
          {/*
            * The wait stands where the Authorize the operator clicked was,
            * with its way out beside it. It used to be a disabled "Working..."
            * here and a Stop waiting at the top of the card, which on a long
            * list was a screen away from the row it stopped.
            */}
          {props.authorizing ? (
            <SignInWait
              name={connection.displayName}
              title={`Stop waiting for ${connection.displayName}. The sign-in page already open in your browser stops working; start again for a fresh one.`}
              onCancel={props.onCancelAuthorization}
            />
          ) : (
            <>
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
                  title={
                    connection.configured
                      ? `Sign in to ${connection.displayName} again and replace the credentials PwrAgent holds. Use this when it stops working or you want a different account.`
                      : `Sign in to ${connection.displayName} in your browser. PwrAgent stores the credentials encrypted in this profile.`
                  }
                  type="button"
                  onClick={props.onAuthorize}
                >
                  {props.busy
                    ? "Working..."
                    : connection.configured ? "Reauthorize" : "Authorize"}
                </button>
              )}
              {/*
                * Disconnect and Remove differ only in whether the row survives, and
                * nothing on screen said so -- two destructive-looking buttons side
                * by side with no way to tell which one you wanted.
                */}
              {connection.configured ? (
                <button
                  className="button button--ghost"
                  disabled={props.disabled}
                  title={`Discard the credentials PwrAgent holds for ${connection.displayName} and close its open sessions. The connection stays in this list, so you can authorize it again without retyping its URL.`}
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
                    title={`Rename ${connection.displayName} or point it at a different URL. A changed URL discards the stored credentials, because they were issued by the old server.`}
                    type="button"
                    onClick={props.onEdit}
                  >
                    Edit
                  </button>
                  <button
                    className="button button--ghost settings-mcp-row__remove"
                    disabled={props.disabled}
                    title={`Delete ${connection.displayName} from PwrAgent entirely -- the row, its URL, and its credentials. Threads that selected it lose access to it.`}
                    type="button"
                    onClick={props.onRemove}
                  >
                    Remove
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="settings-mcp-row__detail">
        {/*
          * The endpoint is the one thing in this row an operator has to hand
          * to something else verbatim -- a `curl`, a bug report, the agent's
          * own config when a server turns out to belong there instead. It was
          * selectable text in a row full of buttons, which in practice means
          * a drag that catches the row instead.
          */}
        <SettingsCopyValue
          compact
          desktopApi={props.desktopApi}
          label={`${connection.displayName} MCP URL`}
          value={connection.serverUrl}
        />
        {/*
          * While it waits, the remedy line would still be telling the operator
          * to authorize -- the thing they just did. It says where the sign-in
          * actually is instead.
          */}
        <p className="settings-mcp-row__state">
          {props.authorizing
            ? `Finish signing in to ${connection.displayName} in your browser.`
            : setup.detail}
        </p>
        {props.authorizationError ? (
          <p
            className="settings-mcp-row__error settings-mcp-row__error--sign-in"
            role="alert"
          >
            Sign-in failed: {props.authorizationError}
          </p>
        ) : null}
        {listable && inventory?.status === "failed" ? (
          <p className="settings-mcp-row__error">{inventory.error}</p>
        ) : null}
      </div>
      {expanded ? (
        <div className="settings-mcp-row__drawer" id={drawerId}>
          {inventory?.status === "loaded" ? (
            <McpInventoryLine
              className="settings-mcp-row__tools"
              label="Tools"
              previewLimit={TOOL_PREVIEW_LIMIT}
              values={inventory.tools}
            />
          ) : (
            <p className="settings-mcp-row__drawer-note">
              {!listable
                ? "Tools are listed once this connection can be reached."
                : inventory?.status === "failed"
                  ? "PwrAgent could not read this server's tools."
                  : inventory?.status === "unavailable"
                    ? "Tool lists aren't available for this connection."
                    : "Reading tools..."}
            </p>
          )}
          {/*
            * Codex re-reads its servers when its configuration reloads. A
            * managed connection has no such moment -- its list is read once
            * and kept -- so a server that gained or lost a tool needs a way
            * to be asked again.
            */}
          {listable && inventory?.status !== "unavailable" ? (
            <button
              className="button button--ghost settings-mcp-row__refresh"
              disabled={inventory?.status === "loading"}
              title={`Ask ${connection.displayName} for its tools again.`}
              type="button"
              onClick={refreshTools}
            >
              {inventory?.status === "loading" ? "Refreshing..." : "Refresh tools"}
            </button>
          ) : null}
        </div>
      ) : null}
      {/*
        * The two switches answer different questions, and side by side with
        * one-word labels they read as a pair of the same thing. Offer decides
        * whether a thread may use the connection at all; the second decides
        * whether a thread that does not exist yet starts with it chosen. Each
        * says so under its name, and the second follows the first: a
        * connection no thread may use cannot be pre-selected on one.
        *
        * Withheld until PwrAgent holds credentials -- a switch claiming a
        * connection is on while it cannot serve a single tool was the defect
        * `resolveMcpConnectionSetup` exists to prevent.
        */}
      {props.onAvailabilityChange && setup.offersAvailabilitySwitch ? (
        <div className="settings-mcp-row__policy">
          <div className="settings-mcp-row__policy-item">
            <SettingsSwitch
              checked={connection.enabled}
              // The gateway switch above already states the reason every
              // connection is off, and the row's own state line repeats it, so
              // this reads as a consequence rather than a dead control.
              disabled={disabled || !props.gatewayEnabled}
              label={`Offer ${connection.displayName} to threads`}
              onChange={props.onAvailabilityChange}
            />
            <span className="settings-mcp-row__policy-text">
              <span className="settings-mcp-row__policy-label">
                Offer to threads
              </span>
              <span className="settings-mcp-row__policy-hint">
                Any thread can choose it under MCP access.
              </span>
            </span>
          </div>
          {props.onSelectForNewThreadsChange ? (
            <div className="settings-mcp-row__policy-item">
              <SettingsSwitch
                // Shown as what a new thread will actually get. A parked
                // connection keeps the stored preference -- offering it again
                // brings the default back -- but it is not seeded, so an `On`
                // here would be a promise the next thread breaks.
                checked={selectedForNewThreads}
                disabled={
                  disabled
                  || !props.gatewayEnabled
                  || !connection.enabled
                }
                label={`Select ${connection.displayName} for new threads`}
                onChange={props.onSelectForNewThreadsChange}
              />
              <span className="settings-mcp-row__policy-text">
                <span className="settings-mcp-row__policy-label">
                  Select for new threads
                </span>
                <span className="settings-mcp-row__policy-hint">
                  {!connection.enabled
                    ? "Offer it to threads first."
                    : seedable
                      ? "New threads start with it selected. Existing threads keep theirs."
                      : "New threads skip it until it is signed in again."}
                </span>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
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

  // Connecting ends in the same browser sign-in as Reauthorize, so it goes
  // through the row's authorization too. On a latch of its own it waited
  // behind a disabled "Connecting..." with no way to call it off, and a
  // missing Local Agent Access landed in the card notice, not on this row.
  if (!props.configured) {
    return (
      <button
        className="button button--secondary"
        disabled={props.disabled || busy}
        type="button"
        onClick={props.onAuthorize}
      >
        {busy ? "Working..." : "Connect"}
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

/**
 * A sign-in waiting on the browser, standing where the control that started it
 * was, with its way out beside it.
 */
function SignInWait(props: {
  name: string;
  /** What calling it off does, for the button's tooltip. */
  title: string;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // The control the operator used to start the sign-in was replaced by this,
  // and focus went with it to the document. Keyboard focus lands on the way
  // out instead of back at the top of the window.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) cancelRef.current?.focus();
  }, []);
  return (
    <>
      <SettingsPendingIndicator pending label="Waiting for sign-in…" />
      <button
        ref={cancelRef}
        aria-label={`Cancel sign-in to ${props.name}`}
        className="button button--secondary"
        title={props.title}
        type="button"
        onClick={props.onCancel}
      >
        Cancel sign-in
      </button>
    </>
  );
}

function McpServerRow(props: {
  disabled: boolean;
  expanded: boolean;
  server: CodexMcpServerSummary;
  /** Where this server's sign-in is, while one is in flight. */
  signIn?: CodexSignInPhase;
  /** Why this server's last sign-in failed, until it is tried again. */
  signInError?: string;
  onCancelSignIn: () => void;
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
            className={`settings-pathrow__chip${chipToneClass(auth.tone)}`}
            title={auth.description}
          >
            {auth.label}
          </span>
        </div>
        <div className="settings-mcp-row__actions">
          {props.signIn === "browser" ? (
            <SignInWait
              name={server.name}
              title={`Stop waiting for ${server.name}. Sign in again for a fresh link.`}
              onCancel={props.onCancelSignIn}
            />
          ) : props.signIn === "starting" ? (
            <SettingsPendingIndicator pending label="Starting…" />
          ) : (
            <>
              {health === "needsSignIn" ? (
                <button
                  className="button button--secondary"
                  disabled={props.disabled}
                  type="button"
                  onClick={props.onSignIn}
                >
                  Sign in
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
            </>
          )}
        </div>
      </div>
      {props.signIn === "browser" ? (
        <p className="settings-mcp-row__state">
          Finish signing in to {server.name} in your browser.
        </p>
      ) : props.signIn === "starting" ? (
        <p className="settings-mcp-row__state">
          Signed in. Starting {server.name} with the new credentials.
        </p>
      ) : props.signInError ? (
        <p
          className="settings-mcp-row__error settings-mcp-row__error--sign-in"
          role="alert"
        >
          {props.signInError}
        </p>
      ) : server.startupError ? (
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

