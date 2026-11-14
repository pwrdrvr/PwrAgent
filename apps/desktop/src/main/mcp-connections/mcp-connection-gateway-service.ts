import { runtimeResourcesPath } from "../runtime-resources";
import { externalLinks as shell } from "../owner-host";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect,
  createServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  ClientCapabilities,
  ElicitRequestParams,
  ElicitResult,
  InitializeResult,
  McpError,
  Notification,
  Progress,
  Root,
} from "@modelcontextprotocol/sdk/types.js";
import { isMcpError, loadedMcpTypes, mcpClient, mcpClientStreamableHttp, mcpTypes } from "./mcp-sdk";
import { McpInitializationTransport } from "./mcp-initialization-transport";
import { McpDiscovery, discoveryFailure, isMcpDiscoveryError, mcpDiscoveryContext, mcpDiscoveryPhaseContext, mcpRequestSignalContext, waitForMcp } from "./mcp-discovery";
import { offersMcpSkills, skillsAwareInstructions } from "./mcp-skills-relay";
import { SandboxerConnection } from "./sandboxer-connection";
import {
  McpStdioLaunchError,
  OwnedStdioClientTransport,
  describeStdioStartFailure,
  normalizeStdioLaunchInput,
  resolveStdioExecutable,
  resolveStdioLaunch,
  type StdioSpawn,
} from "./mcp-stdio-launch";
import { McpStdioSecretVault, type McpStdioSecretSettings } from "./mcp-stdio-secret-vault";
import {
  ConnectionRpcClient,
  PROGRESS_WIRE_OPT_IN,
  bridgeProgress,
} from "./mcp-connection-rpc-client";
import {
  ELICITATION_WIRE_OPT_IN,
  UPSTREAM_THREAD_ELICITATION_CAPABILITIES,
  URL_ELICITATION_WIRE_OPT_IN,
  elicitationUnavailable,
  type ElicitationRoute,
} from "./mcp-elicitation-relay";
import {
  buildUpstreamRoots,
  readRelayedRoots,
  rootsFingerprint,
  type ThreadRootDirectory,
} from "./mcp-upstream-roots";
import {
  ElicitationWireChannel,
  UpstreamElicitationRoutes,
  verbatimElicitRequestSchema,
} from "./mcp-upstream-elicitation";
import { gatewayToolRevision, validateGatewayArguments, type McpGatewayTool, type McpGatewayInvocation } from "./mcp-gateway-catalog";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  isMcpIpcUrl,
  PWRGIT_MCP_CONNECTION_ID,
  SANDBOXER_MCP_CONNECTION_ID,
  isAcpBackendId,
  isBuiltInMcpConnectionId,
  isMcpConnectionToolApproval,
  type AppServerBackendKind,
  type CreateMcpConnectionRequest,
  type ListMcpConnectionToolsRequest,
  type ListMcpConnectionToolsResponse,
  type ProbeMcpConnectionRequest,
  type ProbeMcpConnectionResponse,
  type UpdateMcpConnectionRequest,
  type McpConnectionRecord,
  type McpConnectionStatus,
  type McpThreadSessionState,
  type McpThreadSessionStates,
  type McpConnectionsChangedEvent,
  type McpConnectionToolApproval,
  type McpStdioLaunch,
  type McpStdioLaunchInput,
  type TestMcpStdioConnectionRequest,
  type TestMcpStdioConnectionResponse,
  type ConnectPwrSnapResponse,
  type OpenPwrSnapResponse,
  type OpenSandboxerLinkResponse,
  type PwrSnapConnectionStatus,
  type SandboxerLinkTarget,
  type SandboxerTransport,
  isSandboxerTransport,
  buildThreadIdentityKey,
  MAX_TRANSCRIPT_IMAGE_BYTES,
} from "@pwragent/shared";
import { isSafeExternalOpenUrl } from "../external-url-policy";
import { getMainLogger } from "../log";
import { resolveActiveProfileName } from "../profile";
import {
  getRuntimeLeaseManager,
  type RuntimeLeaseManager,
  type RuntimeLeaseHolder,
} from "../runtime-lease-manager";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getAppStateMode } from "../storage/desktop-runtime-storage";
import { desktopMcpConnectionSelectionStorage, recordCreatedSandbox } from "../storage/desktop-mcp-connection-storage";
import { readCreatedSandbox, type SandboxerCleanupTransport } from "./sandboxer-pr-cleanup";
import {
  McpConnectionRegistry,
} from "./mcp-connection-registry";
import {
  McpConnectionBrokerDiscovery,
  type McpConnectionBrokerRecord,
} from "./mcp-connection-broker-discovery";
import {
  McpCredentialVault,
} from "./mcp-credential-vault";
import { McpOAuthSessionCoordinator } from "./mcp-oauth-session-coordinator";
import {
  PWRSUITE_RELAY_MIN_VERSION,
  defaultPwrSuiteInstallPaths,
  findPwrSuiteRelay,
  isPwrSuiteEndpointListening,
  type PwrSuiteRelayApp,
} from "./pwrsuite-relay";
import { createMcpSafeFetch } from "./mcp-safe-fetch";
import { PwrSnapMediaLinks, readPwrSnapImageContents, type PwrSnapMediaRead } from "./pwrsnap-media-links";
import { RelaySessionPool } from "./mcp-relay-session-pool";
import { createMcpIpcTransport, normalizeMcpIpcBearerToken } from "./mcp-ipc-http";
import { probeMcpConnectionUrl } from "./mcp-connection-probe";
import {
  MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_TIMEOUT_MS,
} from "./mcp-connection-timeouts";

const connectionLog = getMainLogger("pwragent:mcp-connections");
const PWRSNAP_DOWNLOAD_URL =
  "https://github.com/pwrdrvr/PwrSnap/releases/latest";

/** Why a PwrSuite app with no relay cannot be used: it predates local IPC. */
export function pwrSuiteUpdateDetail(app: PwrSuiteRelayApp): string {
  const name = app === "pwrsnap" ? "PwrSnap" : "PwrGit";
  return `Update ${name} to ${PWRSUITE_RELAY_MIN_VERSION[app]} or later, then turn on Local Agent Access.`;
}
const PWRSNAP_NOT_LISTENING_DETAIL =
  "Open PwrSnap and turn on Local Agent Access to connect agents.";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_RPC_LINE_BYTES = 1024 * 1024;
/** An owner answering a PwrSnap image read sends the image itself. */
const MAX_PWRSNAP_MEDIA_RESPONSE_BYTES = Math.ceil(MAX_TRANSCRIPT_IMAGE_BYTES / 3) * 4 + 4096;
const PWRSNAP_MEDIA_READ_TIMEOUT_MS = 15_000;
const MAX_RPC_CONNECTIONS = 32;
/**
 * Attach sockets are held for a bridge child's whole life, one per thread
 * per managed connection, so they are bounded apart from the in-flight RPC
 * sockets rather than allowed to use up their 32 slots.
 */
const MAX_BRIDGE_ATTACHMENTS = 1_024;
/**
 * A server that keeps answering with a cursor is paging forever or paging
 * something far larger than a Settings row can show. Either way the row gets
 * what arrived rather than a spinner that never ends.
 */
const MAX_TOOL_LIST_PAGES = 20;
const MAX_SERVER_INSTRUCTIONS_CHARS = 2_000;
/**
 * How long a Settings test waits for a local command to answer the MCP
 * handshake and list its tools. A first `npx -y` run downloads the package,
 * so this is longer than the URL probe.
 */
const STDIO_TEST_TIMEOUT_MS = 30_000;
/** Threads whose roots the owner holds, and this instance reports. */
const MAX_ROOT_THREADS = 512;
/** A registration repeats this often during a turn; directory changes do not wait for it. */
const ROOTS_REFRESH_INTERVAL_MS = 10_000;
/** Links one session's host opened whose completion it may still be told of. */
const MAX_OPENED_URL_ELICITATIONS = 32;
/** Sign-in links a `-32042` tool error may show the person, one at a time. */
const MAX_REQUIRED_URL_ELICITATIONS = 3;
const GATEWAY_OFF_ERROR =
  "The PwrAgent MCP gateway is turned off. Turn it on in Settings → Plugins to use managed connections.";

type BridgeGrant = {
  connectionId: string;
  threadId?: string;
  /**
   * The backend of a native bridge's thread. A gateway scope names its own;
   * a bare thread id does not, and roots are read per backend and thread.
   */
  backend?: AppServerBackendKind;
};

type ThreadRootsScope = { backend: AppServerBackendKind; threadId: string };

/** What a thread session answers besides the operations it forwards. */
type UpstreamSessionHandlers = {
  /** Only a thread's session can reach a person, so only it takes forms and links. */
  onElicit?: UpstreamElicitHandler;
  /** Only a local command's thread session is told the thread's directories. */
  onListRoots?: (client: Client) => { roots: Root[] };
  onElicitationComplete?: (client: Client, elicitationId: string) => void;
};

type UpstreamSession = {
  client: Client;
  transport: Transport;
};

/** Answers an upstream server's form for a thread session. */
type UpstreamElicitHandler = (
  client: Client,
  request: ElicitRequestParams,
  signal: AbortSignal,
) => Promise<ElicitResult>;

type BridgeRequest = {
  token?: unknown;
  brokerToken?: unknown;
  op?: unknown;
  params?: unknown;
  deadlineAt?: unknown;
  discoveryId?: unknown;
  /** The caller can answer the upstream server's forms on this socket. */
  elicitation?: unknown;
  /** The caller takes the upstream server's progress reports on this socket. */
  progress?: unknown;
  /** With `elicitation`, the caller can also show the upstream server's links. */
  urlElicitation?: unknown;
};

/**
 * Options for a tool call on the upstream session. A caller that takes
 * progress reports makes the SDK ask the server for them. Each report
 * restarts the call's timeout, up to an absolute cap; a server that stops
 * reporting still times out.
 */
function upstreamToolCallOptions(
  signal: AbortSignal | undefined,
  onProgress: ((progress: Progress) => void) | undefined,
): RequestOptions {
  return {
    ...(signal ? { signal } : {}),
    timeout: MCP_CONNECTION_TOOL_TIMEOUT_MS,
    ...(onProgress
      ? {
        onprogress: onProgress,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS,
      }
      : {}),
  };
}

function cancelOnly(signal: AbortSignal | undefined): RequestOptions | undefined {
  return signal ? { signal } : undefined;
}

type BridgeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: number; data?: unknown };

type ProfileOwnership =
  | { owned: true }
  | { owned: false; holder: RuntimeLeaseHolder };

export type McpConnectionBridgeServer = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type McpConnectionBridgeRegistration = {
  server: McpConnectionBridgeServer;
  bindThread: (threadId: string) => void;
  revoke: () => void;
};

type GatewaySettings = Pick<
  ReturnType<typeof getDesktopSettingsService>,
  | "clearPwrSnapMcpCredential"
  | "clearMcpConnectionCredentials"
  | "resolveMcpConnectionCredentials"
  | "resolvePwrSnapMcpCredential"
  | "saveMcpConnectionCredentials"
  | "savePwrSnapMcpCredential"
  | "resolvePwrGitMcpCredential"
  | "clearPwrGitMcpCredential"
>;

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type McpConnectionGatewayServiceOptions = {
  sandboxer?: SandboxerConnection;
  /**
   * A thread's directories, read in the instance that runs the thread. The
   * backend registry sets it with `setThreadRootsResolver` when it is not
   * given here.
   */
  resolveThreadRoots?: (scope: ThreadRootsScope) => Promise<ThreadRootDirectory[]>;
  readGatewaySelection?: (context: { backend: AppServerBackendKind; threadId: string }) => Promise<string[]>;
  bridgeEntryPath?: string;
  fetchFn?: FetchLike;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  resolveInstallPaths?: () => string[];
  /** Whether PwrSnap's local MCP socket or pipe accepts a connection. */
  isPwrSnapListening?: () => Promise<boolean>;
  /** Whether PwrGit's local MCP socket or pipe accepts a connection. */
  isPwrGitListening?: () => Promise<boolean>;
  /** Where PwrGit may be installed; its relay is found inside. */
  resolvePwrGitInstallPaths?: () => string[];
  settings?: GatewaySettings;
  registry?: McpConnectionRegistry;
  credentialVault?: McpCredentialVault;
  leaseManager?: Pick<
    RuntimeLeaseManager,
    "acquire" | "id" | "profile" | "release" | "snapshot" | "shouldRetryAcquisition"
  > | null;
  brokerDiscovery?: McpConnectionBrokerDiscovery;
  /** Profile-wide gateway switch; defaults to the desktop setting. */
  gatewayEnabled?: () => boolean;
  /** Secret environment values for local command connections. */
  stdioSecrets?: McpStdioSecretVault;
  /** Test seam: starts a local command's process. */
  stdioSpawn?: StdioSpawn;
  /**
   * The environment whose PATH resolves a bare program name and is handed to
   * local commands. Defaults to the login-shell environment Codex uses.
   */
  resolveStdioSearchEnv?: () => Promise<NodeJS.ProcessEnv>;
  /** How long a Settings test waits for a local command to answer. */
  stdioTestTimeoutMs?: number;
  /**
   * Records a sandbox a thread created through the built-in Sandboxer
   * connection, so PwrAgent can release exactly that one when the thread's
   * PRs close. Defaults to the profile state database.
   */
  recordCreatedSandbox?: (params: {
    connectionId: string;
    sandboxId: string;
    name?: string;
    backend?: string;
    threadId: string;
    now: number;
  }) => void;
};

/**
 * A connection whose sessions are processes PwrAgent starts on this machine:
 * an operator's local command, or the relay PwrSnap or PwrGit ships. Each
 * session's process stops with the thread that used it and is never
 * restarted for it.
 */
function runsLocalProcess(connection: Pick<McpConnectionRecord, "kind">): boolean {
  return connection.kind === "stdio" || isPwrSuiteRelayKind(connection.kind);
}

function isPwrSuiteRelayKind(kind: McpConnectionRecord["kind"]): kind is PwrSuiteRelayApp {
  return kind === "pwrsnap" || kind === "pwrgit";
}

/**
 * Most PwrSnap or PwrGit sessions one connection opens. A tool call holds a
 * session to itself, so this many tool calls run at once; the next waits.
 */
const MAX_RELAY_SESSIONS = 8;

const ENDED_LOCAL_SESSION_ERROR =
  "The MCP desktop connection ended. Ask the operator to open its desktop app independently if needed, then Reconnect in the thread MCP access panel (or turn this connection off and on). Search tools again and reread relevant skills/resources. Never replay a write or reuse its approval.";

/**
 * What a request may do once a local session's process has ended.
 *
 * An operator's command that exits is never started again for the thread:
 * it may exit on every start. A PwrSnap or PwrGit relay ends whenever its
 * app quits, an update relaunch included. Every thread shares one pool of
 * relay sessions, so the pool opens again for any thread's own request once
 * the app answers on its socket or pipe: a new thread's tool discovery must
 * work after an update. The app grants the role on the relay's command line
 * without asking. An app that predates that still asks, so a delegated Job
 * Monitor, with no operator watching, never reopens it.
 */
export async function endedLocalSessionRestart(input: {
  kind: McpConnectionRecord["kind"];
  operation: unknown;
  delegated: boolean;
  /** Asked only for a relay request that may reopen it. */
  isAppListening: () => Promise<boolean>;
}): Promise<"restart" | "ended" | "app_closed"> {
  if (!isPwrSuiteRelayKind(input.kind) || input.delegated) return "ended";
  return await input.isAppListening() ? "restart" : "app_closed";
}

function endedRelaySessionError(app: PwrSuiteRelayApp, outcome: "ended" | "app_closed"): string {
  const name = app === "pwrsnap" ? "PwrSnap" : "PwrGit";
  return outcome === "app_closed"
    ? `${name} is not open, or its Local Agent Access is off, so this thread's ${name} session cannot start. Ask the operator to open ${name}, then call the tool again. Never replay a write or reuse its approval.`
    : `${name} closed, so its session ended. A Job Monitor cannot reopen it; the thread's own next ${name} request does once ${name} is open. Search tools again and reread relevant skills/resources. Never replay a write or reuse its approval.`;
}



/**
 * The page the browser lands on after the MCP server's authorization screen.
 * Exported for `oauth-callback-page.test.ts`: it is the only part of this
 * service a person ever looks at, and nothing else here renders markup.
 */
export function htmlResponse(
  title: string,
  detail: string,
  options: {
    /**
     * Picks the mark beside PwrAgent's. The two sister apps ship one; every
     * other connection is a remote server PwrAgent has no artwork for and
     * gets the lettered tile instead.
     */
    connectionId?: string;
    displayName?: string;
    liveStatus?: boolean;
  } = {},
): string {
  const safeTitle = escapeHtml(title);
  const displayName = options.displayName ?? "MCP server";
  const safeDisplayName = escapeHtml(displayName);
  const connectionId = options.connectionId;
  const brandedMark = connectionId === PWRSNAP_MCP_CONNECTION_ID
    || connectionId === PWRGIT_MCP_CONNECTION_ID
      ? connectionId
      : undefined;
  const connectedTitle = JSON.stringify(
    `PwrAgent is connected to ${displayName}`,
  ).replaceAll("<", "\\u003c");
  const liveStatus = options.liveStatus === true;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${safeTitle}</title>
  <!-- PwrAgent's own mark, not the server's: this window belongs to
       PwrAgent, and the tab is where someone looks to ask what opened it.
       Same route the diagram below draws from, so it needs no second asset
       and nothing new from this page's own img-src 'self' policy. -->
  <link rel="icon" type="image/png" href="/assets/pwragent.png">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; overflow: hidden; color: #f7f4ef; background: #090909; }
    body::before { content: ""; position: fixed; inset: -25%; pointer-events: none; background: radial-gradient(circle at 28% 42%, rgba(235, 111, 32, .15), transparent 28%), radial-gradient(circle at 72% 42%, rgba(255, 153, 55, .11), transparent 30%); filter: blur(30px); }
    main { position: relative; width: min(880px, calc(100vw - 40px)); padding: 70px 42px 52px; text-align: center; }
    .eyebrow { margin: 0 0 18px; color: #f1883a; font-size: 12px; font-weight: 760; letter-spacing: .18em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(34px, 5.5vw, 64px); line-height: 1.02; letter-spacing: -.045em; }
    .detail { max-width: 610px; margin: 20px auto 0; color: #aaa49d; font-size: 17px; line-height: 1.55; }
    .connection { display: grid; grid-template-columns: 138px minmax(140px, 1fr) 138px; align-items: center; gap: 22px; max-width: 650px; margin: 58px auto 50px; }
    .app { display: grid; justify-items: center; gap: 13px; color: #d9d4cd; font-size: 13px; font-weight: 680; }
    .app-icon { display: grid; place-items: center; width: 104px; height: 104px; padding: 4px; border: 1px solid #2b2926; border-radius: 27px; color: #f1883a; background: #141312; box-shadow: 0 20px 55px rgba(0, 0, 0, .45); font-size: 30px; font-weight: 760; }
    /* Each mark is its own app's icon, copied verbatim, and every one of them
       is full-bleed: the plate covers its whole canvas, so the marks fill
       their tiles at the same size with nothing to compensate for. The
       explicit 100% below is what does the filling and looks removable —
       place-items only centres what is already sized, and without it each
       mark falls back to its intrinsic 256 or 512px. */
    .app-mark { width: 100%; height: 100%; object-fit: contain; }
    .line { position: relative; height: 38px; }
    .line::before { content: ""; position: absolute; top: 18px; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, #8a3c17, #ff8a1f 45%, #ffc174 55%, #8a3c17); box-shadow: 0 0 14px rgba(255, 138, 31, .7); }
    .signal { position: absolute; top: 12px; left: -4px; width: 14px; height: 14px; border: 3px solid #090909; border-radius: 50%; background: #ff9c43; box-shadow: 0 0 0 3px rgba(255, 138, 31, .18), 0 0 18px #ff8a1f; animation: call 1.8s cubic-bezier(.45, 0, .25, 1) infinite; }
    .status { display: inline-flex; align-items: center; gap: 9px; padding: 10px 15px; border: 1px solid #2d2a27; border-radius: 999px; color: #c6c0b9; background: rgba(22, 21, 20, .8); font-size: 13px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff8a1f; box-shadow: 0 0 12px rgba(255, 138, 31, .8); animation: pulse 1.4s ease-in-out infinite; }
    body.is-connected .signal { background: #75d89b; box-shadow: 0 0 0 3px rgba(117, 216, 155, .18), 0 0 18px #75d89b; animation: call 2.4s cubic-bezier(.45, 0, .25, 1) infinite; }
    body.is-connected .status-dot { background: #75d89b; box-shadow: 0 0 12px rgba(117, 216, 155, .8); animation: none; }
    body.is-failed .status-dot { background: #ff6b6b; box-shadow: 0 0 12px rgba(255, 107, 107, .7); animation: none; }
    .close { margin: 20px 0 0; color: #716c66; font-size: 12px; }
    @keyframes call { 0% { left: -4px; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { left: calc(100% - 10px); opacity: 0; } }
    @keyframes pulse { 50% { opacity: .45; transform: scale(.82); } }
    @media (max-width: 640px) { main { padding-inline: 18px; } .connection { grid-template-columns: 92px minmax(70px, 1fr) 92px; gap: 10px; } .app-icon { width: 78px; height: 78px; border-radius: 21px; } }
    @media (prefers-reduced-motion: reduce) { .signal, .status-dot, body.is-connected .signal { animation: none; } body.is-connected .signal { left: calc(100% - 10px); } }
  </style>
</head>
<body${liveStatus ? "" : " class=\"is-failed\""}>
  <main>
    <p class="eyebrow">Secure MCP connection</p>
    <h1 id="title">${safeTitle}</h1>
    <p class="detail" id="detail">${escapeHtml(detail)}</p>
    <!-- role="group" so the label is announced: aria-label is ignored on a
         bare div, which is role="generic", so the relationship this diagram
         draws reached assistive technology as two loose words. -->
    <div class="connection" role="group" aria-label="PwrAgent connection to ${safeDisplayName}">
      <div class="app"><span class="app-icon"><img class="app-mark" src="/assets/pwragent.png" alt=""></span><span>PwrAgent</span></div>
      <div class="line" aria-hidden="true"><span class="signal"></span></div>
      <div class="app">${brandedMark
        ? `<span class="app-icon"><img class="app-mark" src="/assets/${brandedMark}.png" alt=""></span>`
        : `<span class="app-icon" aria-hidden="true">MCP</span>`}<span>${safeDisplayName}</span></div>
    </div>
    <div class="status"><span class="status-dot"></span><span id="status">${liveStatus ? "Finishing secure connection…" : "Connection stopped"}</span></div>
    <!-- Names the app that opened this window. The heading names PwrAgent
         only while the connection is going well; "Connection could not be
         completed" on a stranger's tab names nobody at all. -->
    <p class="close">PwrAgent opened this window — you can close it at any time.</p>
  </main>
  ${liveStatus ? `<script>
    // The heading and the tab move together: the tab is the only part of this
    // page a backgrounded window still shows, and left alone it kept saying
    // "Connecting…" long after the connection was up or had failed.
    const settle = (state, heading, detail, status) => {
      document.body.className = state;
      document.title = heading;
      document.getElementById("title").textContent = heading;
      document.getElementById("detail").textContent = detail;
      document.getElementById("status").textContent = status;
    };
    // PwrAgent stops answering 30s after it finishes with this flow. Without a
    // cap, a tab still open after that polls a closed loopback port four times
    // a second for as long as it stays open, while the page goes on promising
    // a result it can no longer get. Counts consecutive unanswered polls only,
    // so a slow start costs nothing: 240 of them is a minute, well past the
    // close, and any answer at all resets it.
    let unanswered = 0;
    const check = async () => {
      try {
        const response = await fetch("/oauth/status", { cache: "no-store" });
        const result = await response.json();
        unanswered = 0;
        if (result.state === "connected") {
          settle("is-connected", ${connectedTitle}, result.detail, "Secure connection ready");
          return;
        }
        if (result.state === "failed") {
          settle("is-failed", "Connection could not be completed", result.detail, "Connection stopped");
          return;
        }
      } catch {
        if (++unanswered > 240) {
          settle(
            "is-failed",
            "Connection could not be completed",
            "PwrAgent stopped reporting on this connection. Check PwrAgent to see whether it finished.",
            "Connection stopped",
          );
          return;
        }
      }
      setTimeout(check, 250);
    };
    void check();
  </script>` : ""}
</body>
</html>`;
}

const BRANDED_MARKS = ["pwragent", PWRSNAP_MCP_CONNECTION_ID, PWRGIT_MCP_CONNECTION_ID] as const;
type BrandedMark = (typeof BRANDED_MARKS)[number];

function isBrandedMark(value: string): value is BrandedMark {
  return (BRANDED_MARKS as readonly string[]).includes(value);
}

function connectionAsset(name: BrandedMark): Buffer | null {
  const fileName = `${name}-app-icon.png`;
  const sourceFile = name === "pwragent"
    ? "build/icon.png"
    : `src/renderer/src/assets/${name}/${name}-app-icon.png`;
  // `process.resourcesPath` is an Electron addition, and `join` throws on the
  // `undefined` it is everywhere else — outside the loop's try, so the whole
  // function threw instead of returning null. Only Electron has a packaged
  // copy to find, so drop the candidate rather than the caller.
  const candidates = [
    ...(runtimeResourcesPath()
      ? [join(runtimeResourcesPath()!, fileName)]
      : []),
    join(__dirname, "../../", sourceFile),
    join(__dirname, "../../../", sourceFile),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate);
    } catch {
      // Try the next development or packaged location.
    }
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

function callbackHtmlHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

export class McpConnectionGatewayService {
  private readonly consentEpoch = randomBytes(32).toString("base64url");
  private readonly threadConsentEpochs = new Map<string, string>();
  private readonly readGatewaySelection: NonNullable<McpConnectionGatewayServiceOptions["readGatewaySelection"]>;
  private readonly bridgeEntryPath: string;
  private readonly fetchFn: FetchLike;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly openPath: (path: string) => Promise<string>;
  private readonly resolveInstallPaths: () => string[];
  private readonly isPwrSnapListening: () => Promise<boolean>;
  private readonly isPwrGitListening: () => Promise<boolean>;
  private readonly resolvePwrGitInstallPaths: () => string[];
  private readonly settings: GatewaySettings;
  private readonly gatewayEnabled: () => boolean;
  private readonly registry: McpConnectionRegistry;
  private readonly credentialVault: McpCredentialVault;
  private readonly leaseManager:
    | Pick<
        RuntimeLeaseManager,
        "acquire" | "id" | "profile" | "release" | "snapshot" | "shouldRetryAcquisition"
      >
    | null;
  private readonly brokerDiscovery: McpConnectionBrokerDiscovery;
  private bridgeServer?: NetServer;
  private bridgeSocketPath?: string;
  private bridgeSocketDirectory?: string;
  private bridgeStart?: Promise<void>;
  private readonly grants = new Map<string, BridgeGrant>();
  private readonly threadRegistrations = new Map<
    string,
    { server: McpConnectionBridgeServer; token: string }
  >();
  /**
   * When each thread's managed selection was last handed to its agent.
   *
   * An ACP agent cannot be asked what it loaded, so this is the whole of the
   * honest answer for those backends: what PwrAgent passed over, and when.
   * In-memory on purpose — it describes this process's handovers, and a
   * restart has not handed anything over yet.
   */
  private readonly threadHandovers = new Map<string, number>();
  private readonly coordinators = new Map<string, McpOAuthSessionCoordinator>();
  /**
   * The authorization currently out in the browser, per connection.
   *
   * `McpOAuthSessionCoordinator.authorize` already refuses to let a superseded
   * attempt commit tokens or move the connection's state, so a stale flow
   * cannot corrupt anything. What it cannot do is end that flow: an attempt
   * the operator abandoned still holds its loopback listener on its port and
   * still runs to the five-minute callback timeout, and `authorizeConnection`
   * stays unresolved for all of it -- which is what the Settings card sits
   * behind. This map is what makes stopping possible: one entry per
   * connection, torn down by the next attempt or by an explicit cancel.
   */
  private readonly pendingAuthorizations = new Map<string, {
    abandon: (reason: string) => void;
  }>();
  private readonly discoveryHealth = new Map<string, NonNullable<McpConnectionStatus["discovery"]>>();
  private readonly upstreamSessions = new Map<string, UpstreamSession>();
  /**
   * PwrSnap and PwrGit sessions, shared by every thread, per connection.
   * Each connection's relay names one role, and neither app keeps state per
   * thread, so threads do not hold sessions of their own. `identity` changes
   * when the pool is replaced, which retires catalog revisions read from it.
   */
  private readonly relayPools = new Map<string, { pool: RelaySessionPool<Client>; identity: string }>();
  private readonly relaySessions = new WeakMap<Client, UpstreamSession>();
  /**
   * Changes when a thread's grant stops using the shared sessions, so a
   * catalog revision it read before cannot call a tool after it reselects.
   */
  private readonly relayGrantEpochs = new Map<string, string>();
  /** The PwrSnap image links each live session returned to its thread. */
  private readonly pwrSnapMediaLinks = new PwrSnapMediaLinks();
  /**
   * Links each session already failed to read. PwrSnap's refusal stands for
   * that session (history horizon, budget), so a transcript re-read must not
   * ask again.
   */
  private readonly failedPwrSnapMediaReads = new WeakMap<Client, Set<string>>();
  /** Live activity and history may materialize the same link concurrently. */
  private readonly pendingPwrSnapMediaReads = new WeakMap<Client, Map<string, Promise<PwrSnapMediaRead>>>();
  /**
   * In-flight session opens, keyed by bridge token.
   *
   * The bridge child opens a socket per RPC and every one of them carries the
   * same token, so concurrent calls arrive before the first session exists.
   * Without this, each would build its own client and the last write would
   * orphan the others — every teardown path looks a session up by token, so
   * an orphan can never be closed.
   */
  private readonly upstreamStarts = new Map<string, { promise: Promise<Client>; controller: AbortController; waiters: number; discoveryId: string }>();
  /**
   * The last tool list read for each connection outside a thread.
   *
   * In memory, like the sessions: it describes what the server said to this
   * process, and a restart has not asked it anything yet. A generation per
   * connection keeps a read that was in flight across a disconnect, a
   * re-point, or a fresh authorization from caching an answer that belongs to
   * the credentials or the URL it started with.
   */
  private readonly toolInventories = new Map<
    string,
    ListMcpConnectionToolsResponse
  >();
  private readonly toolInventoryReads = new Map<
    string,
    Promise<ListMcpConnectionToolsResponse>
  >();
  private readonly toolInventoryGenerations = new Map<string, number>();
  // Inventory eviction must discard stale Settings reads without changing
  // the schema/consent revisions of unrelated live thread sessions.
  private readonly toolInventoryCacheGenerations = new Map<string, number>();
  private readonly sessionIdentities = new WeakMap<Client, string>();
  private readonly initializations = new WeakMap<Client, InitializeResult>();
  private readonly disconnectedStdioGrants = new Set<string>();
  private connectPromise?: Promise<ConnectPwrSnapResponse>;
  private leaseHeld = false;
  private brokerToken?: string;
  private nonOwnerHolder?: RuntimeLeaseHolder;

  private readonly sandboxer: SandboxerConnection;
  private readonly changeListeners = new Set<(event: McpConnectionsChangedEvent) => void>();
  private readonly stdioSecrets: McpStdioSecretVault;
  private readonly stdioSpawn?: StdioSpawn;
  private readonly resolveStdioSearchEnv: () => Promise<NodeJS.ProcessEnv>;
  private readonly stdioTestTimeoutMs: number;
  /** Live local command processes, per connection, on this machine. */
  private readonly stdioProcessCounts = new Map<string, number>();
  /** Settings tests in flight, so shutdown can stop them too. */
  private readonly stdioTestTransports = new Set<OwnedStdioClientTransport>();
  /**
   * Bridge children holding an attach socket, per grant token.
   *
   * A thread's agent starts PwrAgent's bridge as one of its MCP servers and
   * keeps it for as long as it keeps its MCP servers. The bridge holds one
   * socket open for that whole time, so when the last one closes, the
   * thread's agent has let go and a local command started for it is stopped.
   */
  private readonly bridgeAttachments = new Map<string, Set<Socket>>();
  private bridgeAttachmentCount = 0;
  private readonly rpcSockets = new Set<Socket>();
  private activeRpcSockets = 0;
  /** Requests in flight per thread session, for routing upstream forms. */
  private readonly elicitationRoutes = new UpstreamElicitationRoutes();
  /** The owner's roots per thread identity, as the thread's instance reported them. */
  private readonly threadRoots = new Map<string, Root[]>();
  /**
   * The roots each session last read or was last told had changed. Absent
   * until the session first asks, so a session that never asked is not told.
   */
  private readonly rootsKnown = new WeakMap<Client, string>();
  /** Threads whose roots this instance reports because it registered their grants. */
  private readonly rootThreads = new Map<string, { scope: ThreadRootsScope; refreshedAt: number; generation: number }>();
  /** Each thread's report in flight, so reports reach the owner in order. */
  private readonly rootReports = new Map<string, Promise<void>>();
  private threadRootsResolver?: (scope: ThreadRootsScope) => Promise<ThreadRootDirectory[]>;
  /** Links a native host opened, per session, so the server's completion can follow. */
  private readonly openedUrlElicitations = new WeakMap<Client, Map<string, string>>();
  private readonly recordCreatedSandbox: NonNullable<McpConnectionGatewayServiceOptions["recordCreatedSandbox"]>;

  constructor(options: McpConnectionGatewayServiceOptions = {}) {
    this.recordCreatedSandbox = options.recordCreatedSandbox
      ?? recordCreatedSandbox;
    this.threadRootsResolver = options.resolveThreadRoots;
    this.readGatewaySelection = options.readGatewaySelection
      ?? (async (context) => desktopMcpConnectionSelectionStorage.readSelection(context));
    this.bridgeEntryPath =
      options.bridgeEntryPath ?? join(__dirname, "mcp-connection-bridge.js");
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
    this.sandboxer = options.sandboxer
      ?? new SandboxerConnection(undefined, { openExternal: this.openExternal });
    this.sandboxer.onStatusChanged(() => this.announceChanged([SANDBOXER_MCP_CONNECTION_ID]));
    this.openPath = options.openPath ?? ((path) => shell.openPath(path));
    this.resolveInstallPaths =
      options.resolveInstallPaths ?? (() => defaultPwrSuiteInstallPaths("pwrsnap"));
    this.isPwrSnapListening =
      options.isPwrSnapListening ?? (async () => await isPwrSuiteEndpointListening("pwrsnap"));
    this.isPwrGitListening =
      options.isPwrGitListening ?? (async () => await isPwrSuiteEndpointListening("pwrgit"));
    this.resolvePwrGitInstallPaths =
      options.resolvePwrGitInstallPaths ?? (() => defaultPwrSuiteInstallPaths("pwrgit"));
    this.settings = options.settings ?? getDesktopSettingsService();
    this.gatewayEnabled =
      options.gatewayEnabled
      ?? (() => {
        try {
          return getDesktopSettingsService().resolveMcpGatewayEnabled();
        } catch {
          // An unreadable config must not strand threads that already
          // depend on a connection; the default is on.
          return true;
        }
      });
    this.registry = options.registry ?? new McpConnectionRegistry();
    this.credentialVault =
      options.credentialVault
      ?? new McpCredentialVault({ settings: this.settings });
    this.leaseManager = options.leaseManager === undefined
      ? getRuntimeLeaseManager()
      : options.leaseManager;
    this.brokerDiscovery =
      options.brokerDiscovery ?? new McpConnectionBrokerDiscovery();
    this.stdioSecrets = options.stdioSecrets ?? new McpStdioSecretVault(
      hasStdioSecretStore(this.settings) ? { settings: this.settings } : {},
    );
    this.stdioSpawn = options.stdioSpawn;
    this.resolveStdioSearchEnv = options.resolveStdioSearchEnv
      ?? (async () => await getDesktopSettingsService().resolveCodexSpawnEnvAsync());
    this.stdioTestTimeoutMs = options.stdioTestTimeoutMs ?? STDIO_TEST_TIMEOUT_MS;
  }

  async readStatus(): Promise<PwrSnapConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<PwrSnapConnectionStatus>(
        ownership.holder,
        "broker/pwrsnap-status",
      );
    }
    const relay = this.findRelay("pwrsnap");
    const listening = await this.isPwrSnapListening();
    const installed = listening || Boolean(this.findInstalledPath());
    // The relay ships with PwrSnap 1.3.0 and later. An older PwrSnap only
    // serves the loopback OAuth listener this build no longer uses.
    const detail = !installed
      ? undefined
      : !relay
        ? pwrSuiteUpdateDetail("pwrsnap")
        : !listening
          ? PWRSNAP_NOT_LISTENING_DETAIL
          : undefined;
    return {
      connectionId: PWRSNAP_MCP_CONNECTION_ID,
      displayName: "PwrSnap",
      availability: listening
        ? "running"
        : installed
          ? "installed"
          : "not_installed",
      configured: relay !== undefined,
      ...(detail ? { detail } : {}),
    };
  }

  async openDownload(): Promise<OpenPwrSnapResponse> {
    try {
      await this.openExternal(PWRSNAP_DOWNLOAD_URL);
      return { opened: true };
    } catch (error) {
      return {
        opened: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async openApplication(): Promise<OpenPwrSnapResponse> {
    const installedPath = this.findInstalledPath();
    if (!installedPath) {
      return { opened: false, error: "PwrSnap is not installed." };
    }
    const error = await this.openPath(installedPath);
    return error ? { opened: false, error } : { opened: true };
  }

  async connect(): Promise<ConnectPwrSnapResponse> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<ConnectPwrSnapResponse>(
        ownership.holder,
        "broker/pwrsnap-connect",
      );
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connectNow().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return await this.connectPromise;
  }

  /**
   * Hear when a connection's status may have changed through this instance:
   * a mutation it made (or forwarded to the owner broker), or a Sandboxer
   * CLI answer that differs from the last. See `McpConnectionsChangedEvent`.
   */
  onConnectionsChanged(
    listener: (event: McpConnectionsChangedEvent) => void,
  ): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Announces a mutation's result, so each return point stays one line. */
  private announced<T extends { id: string }>(status: T): T {
    this.announceChanged([status.id]);
    return status;
  }

  private announceChanged(connectionIds: readonly string[]): void {
    const event: McpConnectionsChangedEvent = { connectionIds: [...connectionIds] };
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (error) {
        // A window that cannot hear the change must not fail the mutation.
        connectionLog.warn("MCP connection change listener failed", { error });
      }
    }
  }

  async listConnections(
    options: { cachedLocalStatus?: boolean; sandboxerStatusMaxAgeMs?: number } = {},
  ): Promise<McpConnectionStatus[]> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<McpConnectionStatus[]>(
        ownership.holder,
        "broker/list",
        options,
      );
    }
    return await Promise.all(
      this.registry.list().map(async (connection) =>
        await this.connectionStatus(
          connection,
          options.cachedLocalStatus,
          options.sandboxerStatusMaxAgeMs,
        ),
      ),
    );
  }

  async createConnection(
    request: CreateMcpConnectionRequest,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      if (request.ipcBearerToken !== undefined) {
        throw new Error("Set the IPC session token in the PwrAgent instance that owns this profile's MCP gateway.");
      }
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/create",
        request,
      ));
    }
    if (request.stdio !== undefined) {
      if (request.ipcBearerToken !== undefined) throw new Error("Session bearer tokens require a local IPC URL.");
      if (request.serverUrl !== undefined) {
        throw new Error("Add either a remote URL or a local command, not both.");
      }
      const { launch, secretValues } = await this.prepareStdioLaunch(request.stdio);
      const connection = this.registry.createStdio({ displayName: request.displayName, launch });
      try {
        await this.stdioSecrets.write(connection.id, secretValues);
      } catch (error) {
        // A row whose secrets never landed could only ever fail to start.
        this.registry.remove(connection.id);
        throw error;
      }
      return this.announced(await this.connectionStatus(connection));
    }
    if (typeof request.serverUrl !== "string") {
      throw new Error("Enter a remote MCP URL or a local command.");
    }
    const ipcBearerToken = request.ipcBearerToken === undefined ? undefined : normalizeMcpIpcBearerToken(request.ipcBearerToken);
    if (ipcBearerToken !== undefined && !isMcpIpcUrl(request.serverUrl)) throw new Error("Session bearer tokens require a local IPC URL.");
    const connection = this.registry.create({
      displayName: request.displayName,
      serverUrl: request.serverUrl,
    });
    try {
      if (ipcBearerToken) await this.credentialVault.write(connection.id, { resourceUrl: connection.serverUrl, ipcBearerToken });
    } catch (error) {
      this.registry.remove(connection.id);
      throw error;
    }
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Start a local command once, read its tools, and stop it.
   *
   * Nothing is written. The process is not one of a thread's running copies,
   * and it is stopped on every path out of here, including shutdown.
   */
  async testStdioConnection(
    request: TestMcpStdioConnectionRequest,
  ): Promise<TestMcpStdioConnectionResponse> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<TestMcpStdioConnectionResponse>(
        ownership.holder,
        "broker/test-stdio",
        request,
      );
    }
    if (!this.gatewayEnabled()) {
      return { ok: false, problem: "gateway_off", message: GATEWAY_OFF_ERROR };
    }
    const existing = request.connectionId
      ? this.requireConnection(request.connectionId)
      : undefined;
    if (existing && existing.kind !== "stdio") {
      return { ok: false, problem: "invalid", message: "That connection is not a local command." };
    }
    let command: string | undefined;
    let transport: OwnedStdioClientTransport | undefined;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("The local command did not answer in time.", "TimeoutError")),
      this.stdioTestTimeoutMs,
    );
    timer.unref?.();
    const displayName = existing?.displayName ?? "The server";
    try {
      const { launch, secretValues } = await this.prepareStdioLaunch(request.stdio, existing?.id);
      command = launch.command;
      // Not counted toward "Running": no thread is using this copy.
      transport = await this.createStdioTransport("", launch, secretValues);
      this.stdioTestTransports.add(transport);
      const { Client } = await mcpClient.load();
      const client = new Client({ name: "pwragent-settings-test", version: "1.0.0" }, { capabilities: {} });
      const abort = (): void => { void transport?.close().catch(() => undefined); };
      controller.signal.addEventListener("abort", abort, { once: true });
      try {
        await client.connect(transport, { timeout: this.stdioTestTimeoutMs, signal: controller.signal });
        let toolCount = 0;
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
          const result = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: this.stdioTestTimeoutMs,
            signal: controller.signal,
          });
          toolCount += result.tools.length;
          cursor = result.nextCursor;
          if (!cursor || cursors.has(cursor)) break;
          cursors.add(cursor);
        }
        const version = client.getServerVersion();
        return {
          ok: true,
          command: launch.command,
          ...(version?.name ? { serverName: version.name } : {}),
          ...(version?.version ? { serverVersion: version.version } : {}),
          toolCount,
          elapsedMs: Date.now() - startedAt,
        };
      } finally {
        controller.signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      const failure = describeStdioStartFailure({
        error,
        transport,
        displayName,
        command: command ?? request.stdio?.command ?? "The command",
        timedOut: controller.signal.aborted
          || (isMcpError(error) && error.code === loadedMcpTypes().ErrorCode.RequestTimeout),
      });
      return {
        ok: false,
        problem: failure.problem,
        message: failure.message,
        ...(failure.output ? { output: failure.output } : {}),
        ...(command ? { command } : {}),
      };
    } finally {
      clearTimeout(timer);
      if (transport) {
        await transport.close().catch(() => undefined);
        this.stdioTestTransports.delete(transport);
      }
    }
  }

  /**
   * Validate a submitted launch and resolve everything it names.
   *
   * The executable is looked up now and stored as an absolute path; the
   * folder has to exist; a secret left blank on an edit keeps its stored
   * value, and one left blank anywhere else is an error.
   */
  private async prepareStdioLaunch(
    input: McpStdioLaunchInput,
    connectionId?: string,
  ): Promise<{ launch: McpStdioLaunch; secretValues: Record<string, string> }> {
    const normalized = normalizeStdioLaunchInput(input);
    const searchEnv = await this.readStdioSearchEnv();
    const command = await resolveStdioExecutable(normalized.command, searchEnv);
    if (normalized.cwd) {
      const info = await stat(normalized.cwd).catch(() => undefined);
      if (!info?.isDirectory()) {
        throw new McpStdioLaunchError("invalid", `The folder ${normalized.cwd} does not exist.`);
      }
    }
    let stored: Record<string, string> | undefined;
    // Keyed by variable names the operator typed: no prototype to collide with.
    const secretValues: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const entry of normalized.env) {
      if (!entry.secret) continue;
      if (entry.value !== undefined && entry.value !== "") {
        secretValues[entry.name] = entry.value;
        continue;
      }
      if (connectionId) {
        try {
          stored ??= await this.stdioSecrets.read(connectionId);
        } catch {
          throw new McpStdioLaunchError(
            "secret_unavailable",
            "PwrAgent could not read this server's stored secrets. Enter each secret again.",
          );
        }
        const kept = Object.hasOwn(stored, entry.name) ? stored[entry.name] : undefined;
        if (kept !== undefined) {
          secretValues[entry.name] = kept;
          continue;
        }
      }
      throw new McpStdioLaunchError("invalid", `Enter a value for ${entry.name}.`);
    }
    return {
      launch: {
        command,
        args: normalized.args,
        ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
        env: normalized.env.map((entry) => entry.secret
          ? { name: entry.name, secret: true }
          : { name: entry.name, secret: false, value: entry.value ?? "" }),
      },
      secretValues,
    };
  }

  private async readStdioSearchEnv(): Promise<NodeJS.ProcessEnv> {
    try {
      return await this.resolveStdioSearchEnv();
    } catch (error) {
      connectionLog.warn("login-shell environment unavailable for a local MCP command", {
        error: error instanceof Error ? error.message : String(error),
      });
      return process.env;
    }
  }

  /** A transport for a local command, counted while its process runs. */
  private async createStdioTransport(
    connectionId: string,
    launch: McpStdioLaunch,
    secretValues: Record<string, string>,
  ): Promise<OwnedStdioClientTransport> {
    const searchEnv = await this.readStdioSearchEnv();
    const resolved = resolveStdioLaunch({
      launch,
      secretValues,
      processEnv: process.env,
      ...(searchEnv.PATH ? { loginShellPath: searchEnv.PATH } : {}),
    });
    return new OwnedStdioClientTransport(resolved, this.stdioSpawn, {
      onSpawn: () => {
        if (!connectionId) return;
        this.stdioProcessCounts.set(connectionId, (this.stdioProcessCounts.get(connectionId) ?? 0) + 1);
      },
      onExit: () => {
        if (!connectionId) return;
        const next = (this.stdioProcessCounts.get(connectionId) ?? 1) - 1;
        if (next > 0) this.stdioProcessCounts.set(connectionId, next);
        else this.stdioProcessCounts.delete(connectionId);
      },
    });
  }

  /**
   * Opens a Sandboxer page from this machine. Local mode uses the CLI
   * dashboard handoff; hosted mode leaves sign-in to the browser.
   */
  async openSandboxerLink(target: SandboxerLinkTarget): Promise<OpenSandboxerLinkResponse> {
    const connection = this.requireConnection(SANDBOXER_MCP_CONNECTION_ID);
    if (connection.authMode === "oauth" && target === "dashboard") {
      await this.openExternal("https://sandboxer.com/dashboard");
      return { opened: true };
    }
    return await this.sandboxer.openLink(target);
  }

  async authorizeConnection(connectionId: string): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/authorize",
        { connectionId },
      ));
    }
    const connection = this.requireConnection(connectionId);
    if (isMcpIpcUrl(connection.serverUrl)) {
      throw new Error("Local IPC uses the server app's approval, not browser OAuth. Approve access in the server app and check the connection in Settings.");
    }
    if (connection.kind === "stdio") {
      throw new Error(`${connection.displayName} is a local command. It has nothing to sign in to.`);
    }
    if (isPwrSuiteRelayKind(connection.kind)) {
      // The app approves each session in its own window, so there is nothing
      // to sign in to. An OAuth credential from before local IPC opens
      // nothing now, so it is dropped. A new install can offer other tools.
      await this.credentialVault.delete(connection.id);
      if (connection.kind === "pwrsnap") await this.settings.clearPwrSnapMcpCredential();
      this.invalidateConnectionTools(connectionId);
      return this.announced(await this.connectionStatus(connection));
    }
    if (connection.kind === "sandboxer" && connection.authMode === "local_cli") {
      // The CLI may have logged into a different account since this process
      // started. Only then retire servers holding the previous login and its
      // catalog: Settings refreshes on window focus during setup, and closing
      // a live `sbx mcp` drops the sandbox a thread was implicitly using.
      const { accountChanged } = await this.sandboxer.refreshStatus();
      if (accountChanged) {
        await this.closeConnectionSessions(connectionId);
        this.invalidateConnectionTools(connectionId);
      }
      return this.announced(await this.connectionStatus(connection));
    }
    // Restore the first attempt's state before its callback rejection runs.
    this.coordinatorFor(connection).abandonAuthorization();
    this.abandonPendingAuthorization(
      connectionId,
      `A newer ${connection.displayName} authorization replaced this one.`,
    );
    await this.closeConnectionSessions(connectionId);
    const authorizationState = randomBytes(24).toString("base64url");
    const callback = await this.createOAuthCallback(
      authorizationState,
      connection.displayName,
      connection.id,
    );
    this.pendingAuthorizations.set(connectionId, { abandon: callback.abandon });
    try {
      await this.coordinatorFor(connection).authorize({
        redirectUrl: callback.url,
        state: authorizationState,
        onRedirect: async (url) => await this.openAuthorizationUrl(url),
        waitForCode: callback.waitForCode,
      });
      // A different account can see a different set of tools.
      this.invalidateConnectionTools(connectionId);
      callback.complete(
        "connected",
        `PwrAgent can now offer ${connection.displayName} to the agents and threads you choose.`,
      );
      return this.announced(await this.connectionStatus(connection));
    } catch (cause) {
      callback.complete(
        "failed",
        cause instanceof Error
          ? cause.message
          : "The secure connection could not be completed.",
      );
      // Its sessions are already closed and its state moved; other windows
      // must hear it as they would a success.
      this.announceChanged([connectionId]);
      throw cause;
    } finally {
      if (this.pendingAuthorizations.get(connectionId)?.abandon === callback.abandon) {
        this.pendingAuthorizations.delete(connectionId);
      }
      await callback.close();
    }
  }

  /**
   * Release PwrAgent's side of an authorization the operator gave up on.
   *
   * The browser round trip is beyond reach; this closes the loopback listener
   * waiting for it so the port is free and the in-flight `authorizeConnection`
   * rejects now rather than at the five-minute timeout. Returns the
   * connection's state afterwards, which is the one it held before the attempt
   * began -- cancelling authorization is not the same as disconnecting, and
   * neither the stored credentials nor the reported state are changed by it.
   */
  async cancelAuthorization(connectionId: string): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/cancel-authorize",
        { connectionId },
      ));
    }
    const connection = this.requireConnection(connectionId);
    if (connection.authMode === "local_cli" || connection.authMode === "none") return this.announced(await this.connectionStatus(connection));
    // Retire the attempt in the coordinator *before* ending its wait, so the
    // rejection that follows lands on a stale attempt and cannot report a
    // called-off authorization as `reauthorization_required`. Doing it the
    // other way round is a race the cancel loses: the reject resolves the
    // coordinator's catch first, and a healthy connection ends up claiming
    // "Login required" with its credentials untouched.
    this.coordinatorFor(connection).abandonAuthorization();
    this.abandonPendingAuthorization(
      connectionId,
      `${connection.displayName} authorization was cancelled.`,
    );
    return this.announced(await this.connectionStatus(connection));
  }

  private abandonPendingAuthorization(connectionId: string, reason: string): void {
    const pending = this.pendingAuthorizations.get(connectionId);
    if (!pending) return;
    this.pendingAuthorizations.delete(connectionId);
    pending.abandon(reason);
  }

  /**
   * Rename or re-point a connection.
   *
   * A changed URL drops the stored credentials before the record moves: they
   * were issued by the old server, and leaving them in place would let a
   * connection report `Ready` against an endpoint that never authorized it.
   */
  async updateConnection(
    request: UpdateMcpConnectionRequest,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      if (request.ipcBearerToken !== undefined) {
        throw new Error("Set the IPC session token in the PwrAgent instance that owns this profile's MCP gateway.");
      }
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/update",
        request,
      ));
    }
    const existing = this.requireConnection(request.connectionId);
    const ipcBearerToken = request.ipcBearerToken === undefined ? undefined : normalizeMcpIpcBearerToken(request.ipcBearerToken);
    if (ipcBearerToken !== undefined && !isMcpIpcUrl(request.serverUrl ?? existing.serverUrl)) throw new Error("Session bearer tokens require a local IPC URL.");
    if (existing.kind === "stdio") {
      return this.announced(await this.updateStdioConnection(existing, request));
    }
    if (request.stdio !== undefined) {
      throw new Error("A remote server has no command. Remove it and add a local command instead.");
    }
    const { connection, serverUrlChanged } = this.registry.update({
      connectionId: request.connectionId,
      displayName: request.displayName,
      serverUrl: request.serverUrl,
    });
    if (serverUrlChanged) {
      await this.closeConnectionSessions(request.connectionId);
      if (existing.authMode === "oauth") await this.coordinatorFor(existing).disconnect();
      else if (isMcpIpcUrl(existing.serverUrl)) await this.credentialVault.delete(existing.id);
      this.coordinators.delete(request.connectionId);
      this.invalidateConnectionTools(request.connectionId);
    }
    if (ipcBearerToken !== undefined) {
      await this.closeConnectionSessions(request.connectionId);
      if (ipcBearerToken) await this.credentialVault.write(connection.id, { resourceUrl: connection.serverUrl, ipcBearerToken });
      else await this.credentialVault.delete(connection.id);
      this.invalidateConnectionTools(connection.id);
    }
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Rename or re-launch a local command.
   *
   * A changed launch stops every running copy: a thread's next call starts
   * the new command, rather than a server that was configured differently
   * from what Settings now shows. Secrets are written after the record, and
   * the record is put back if they cannot be.
   */
  private async updateStdioConnection(
    existing: McpConnectionRecord,
    request: UpdateMcpConnectionRequest,
  ): Promise<McpConnectionStatus> {
    if (request.serverUrl !== undefined) {
      throw new Error("A local command has no URL. Remove it and add a remote server instead.");
    }
    const prepared = request.stdio
      ? await this.prepareStdioLaunch(request.stdio, existing.id)
      : undefined;
    // A save from the edit dialog always carries the launch. Only a launch or
    // secret that actually changed restarts running copies; a rename must not
    // throw away every thread's server state.
    const previousSecrets = prepared
      ? await this.stdioSecrets.read(existing.id).catch(() => undefined)
      : undefined;
    const secretsChanged = prepared !== undefined
      && !sameSecretValues(previousSecrets, prepared.secretValues);
    const { connection, launchChanged } = this.registry.update({
      connectionId: existing.id,
      ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
      ...(prepared ? { launch: prepared.launch } : {}),
    });
    if (prepared && secretsChanged) {
      try {
        await this.stdioSecrets.write(existing.id, prepared.secretValues);
      } catch (error) {
        this.registry.update({
          connectionId: existing.id,
          displayName: existing.displayName,
          launch: existing.stdio!,
        });
        throw error;
      }
    }
    if (launchChanged || secretsChanged) {
      await this.closeConnectionSessions(existing.id);
      this.discoveryHealth.delete(existing.id);
    }
    return await this.connectionStatus(connection);
  }

  /**
   * Check a URL before a record exists for it.
   *
   * `createConnection` persists first and authorizes second, so every failure
   * — a typo, a stdio command line, a bearer-token server — produced a saved
   * row and a raw error string with no way to edit it. Probing first lets the
   * screen say what it found, in the operator's terms, while nothing is
   * written.
   */
  async probeConnection(
    request: ProbeMcpConnectionRequest,
  ): Promise<ProbeMcpConnectionResponse> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<ProbeMcpConnectionResponse>(
        ownership.holder,
        "broker/probe",
        request,
      );
    }
    // Probe and authorization share transport rules, including support for
    // configured servers on private networks and custom loopback endpoints.
    return await probeMcpConnectionUrl(
      request.serverUrl,
      createMcpSafeFetch({ fetchFn: this.fetchFn }),
    );
  }

  /**
   * The bridge a thread is actually running for a connection, if any.
   *
   * Only the caller that builds the agent's config knows how a bridge is
   * aliased there, so this hands back the registration rather than a name.
   */
  peekThreadBridge(
    connectionId: string,
    threadId: string,
  ): McpConnectionBridgeServer | undefined {
    return this.threadRegistrations.get(`${connectionId}:${threadId}`)?.server;
  }

  /** When this thread's selection was last handed to the agent, in epoch ms. */
  threadHandoverAt(threadId: string): number | undefined {
    return this.threadHandovers.get(threadId);
  }

  /** Records that a thread's selection reached the agent. */
  noteThreadHandover(threadId: string, at: number): void {
    this.threadHandovers.set(threadId, at);
  }

  async disconnectConnection(connectionId: string): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/disconnect",
        { connectionId },
      ));
    }
    const connection = this.requireConnection(connectionId);
    await this.closeConnectionSessions(connectionId);
    if (isMcpIpcUrl(connection.serverUrl)) {
      await this.credentialVault.delete(connection.id);
      this.invalidateConnectionTools(connectionId);
      return this.announced(await this.connectionStatus(this.registry.setEnabled(connectionId, false)));
    }
    if (connection.kind === "sandboxer" && connection.authMode === "local_cli") {
      return this.announced(await this.connectionStatus(this.registry.setEnabled(connectionId, false)));
    }
    // A local command holds no credentials to discard; stopping its running
    // copies is all a disconnect can mean. PwrSnap revokes the session its
    // relay held when the relay stops.
    if (runsLocalProcess(connection)) return this.announced(await this.connectionStatus(connection));
    if (connection.authMode === "oauth") await this.coordinatorFor(connection).disconnect();
    this.invalidateConnectionTools(connectionId);
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Park or restore a connection profile-wide.
   *
   * Disabling closes live sessions so a thread mid-flight stops using a
   * connection the operator just withdrew, but leaves credentials intact so
   * re-enabling does not force another browser authorization.
   */
  async setConnectionEnabled(
    connectionId: string,
    enabled: boolean,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/set-enabled",
        { connectionId, enabled },
      ));
    }
    this.requireConnection(connectionId);
    const connection = this.registry.setEnabled(connectionId, enabled);
    if (!enabled) {
      await this.closeConnectionSessions(connectionId);
    }
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Choose whether a new thread starts with this connection selected.
   *
   * Nothing live changes: no session opens or closes, and no existing thread's
   * selection is touched. The flag is read when a new-thread draft is seeded,
   * which is where `mcpConnectionIdsForNewThread` also refuses a connection
   * that is parked or has no working credentials.
   */
  async setConnectionSelectForNewThreads(
    connectionId: string,
    selectForNewThreads: boolean,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/set-select-for-new-threads",
        { connectionId, selectForNewThreads },
      ));
    }
    this.requireConnection(connectionId);
    const connection = this.registry.setSelectForNewThreads(
      connectionId,
      selectForNewThreads,
    );
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Choose whether PwrAgent cleans up the sandboxes a thread created once
   * every PR attached to that thread has merged or closed.
   *
   * Nothing live changes. The flag is read when a thread's last open PR
   * merges or closes, so the next such PR follows it.
   */
  async setSandboxerCleanupOnPrClose(
    enabled: boolean,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/set-sandboxer-cleanup-on-pr-close",
        { enabled },
      ));
    }
    const connection = this.registry.setSandboxerCleanupOnPrClose(enabled);
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Choose whether images in text pasted from Linear are fetched through a
   * Linear connection. Nothing live changes: the next paste reads it.
   */
  async setLinearPasteImages(enabled: boolean): Promise<void> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      await this.requestOwnerBroker<null>(
        ownership.holder,
        "broker/set-linear-paste-images",
        { enabled },
      );
      return;
    }
    this.registry.setLinearPasteImages(enabled);
    // Announced even with no Linear connection, so every Settings window
    // re-reads the switch.
    this.announceChanged(
      this.registry.list()
        .filter((connection) => connection.linearPasteImages !== undefined)
        .map((connection) => connection.id),
    );
  }

  /** Whether images in text pasted from Linear are attached. Profile-local. */
  isLinearPasteImagesEnabled(): boolean {
    return this.registry.isLinearPasteImagesEnabled();
  }

  /**
   * The Linear connections a paste may fetch images through, or `undefined`
   * when the setting is off. Reads the local registry, like
   * `isSandboxerCleanupOnPrCloseEnabled`: config.toml is profile-local.
   * Signed-in state is checked when the session opens.
   */
  linearPasteConnectionIds(): string[] | undefined {
    // The setting also governs fetching a fresh signed link, which needs no
    // connection, so it is read from config rather than from Linear rows.
    if (!this.registry.isLinearPasteImagesEnabled()) return undefined;
    return this.registry.list()
      .filter((connection) => connection.linearPasteImages !== undefined && connection.enabled)
      .map((connection) => connection.id);
  }

  async setSandboxerTransport(transport: SandboxerTransport): Promise<McpConnectionStatus> {
    if (!isSandboxerTransport(transport)) throw new Error("Choose a Sandboxer transport.");
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder, "broker/set-sandboxer-transport", { transport },
      ));
    }
    const previous = this.requireConnection(SANDBOXER_MCP_CONNECTION_ID);
    if ((previous.authMode === "oauth" ? "hosted" : "local_cli") === transport) {
      return this.announced(await this.connectionStatus(previous));
    }
    this.coordinators.get(previous.id)?.abandonAuthorization();
    this.abandonPendingAuthorization(previous.id, "Sandboxer connection method changed.");
    await this.closeConnectionSessions(previous.id);
    // Keep endpoint-bound credentials for a later explicit switch back.
    this.coordinators.delete(previous.id);
    this.invalidateConnectionTools(previous.id);
    const connection = this.registry.setSandboxerTransport(transport);
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Whether Sandboxer cleanup on PR close is on.
   *
   * Reads the local registry rather than asking the owner broker: config.toml
   * is profile-local, so every instance on the profile reads the same value.
   */
  isSandboxerCleanupOnPrCloseEnabled(): boolean {
    return (
      this.registry.get(SANDBOXER_MCP_CONNECTION_ID)?.sandboxerCleanupOnPrClose
      !== false
    );
  }

  /**
   * Choose when a gateway call to this connection asks first.
   *
   * Nothing live changes. The gateway reads the mode as each call reaches
   * approval, so the next call follows it and a running one is not touched.
   */
  async setConnectionToolApproval(
    connectionId: string,
    toolApproval: McpConnectionToolApproval,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/set-tool-approval",
        { connectionId, toolApproval },
      ));
    }
    this.requireConnection(connectionId);
    const connection = this.registry.setToolApproval(connectionId, toolApproval);
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * Set or clear one project's Tool approval for a connection. Like the
   * connection's own mode, the gateway reads it as each call reaches
   * approval, so nothing live changes.
   */
  async setConnectionProjectToolApproval(
    connectionId: string,
    repository: string,
    toolApproval: McpConnectionToolApproval | null,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/set-project-tool-approval",
        { connectionId, repository, toolApproval },
      ));
    }
    this.requireConnection(connectionId);
    const connection = this.registry.setProjectToolApproval(connectionId, repository, toolApproval);
    return this.announced(await this.connectionStatus(connection));
  }

  /**
   * The tools a managed connection publishes, read outside any thread.
   *
   * A managed connection is only ever opened on a thread's behalf, so
   * Settings could name it but not say what it offers -- the Codex list below
   * it shows every tool because Codex has already started those servers. This
   * opens a short-lived session of its own, pages through `tools/list`, and
   * closes it again, keeping the answer until something that could change it
   * happens.
   *
   * A parked connection is still listed: this is the operator inspecting a
   * server, not a thread reaching one, and "what would I be offering?" is a
   * fair question to ask before offering it. The gateway switch is honored,
   * because turning it off is the operator saying PwrAgent should not be
   * talking to these servers at all.
   */
  async listConnectionTools(
    request: ListMcpConnectionToolsRequest,
  ): Promise<ListMcpConnectionToolsResponse> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<ListMcpConnectionToolsResponse>(
        ownership.holder,
        "broker/list-tools",
        request,
      );
    }
    if (!this.gatewayEnabled()) throw new Error(GATEWAY_OFF_ERROR);
    const connection = this.requireConnection(request.connectionId);
    if (request.refresh) this.invalidateConnectionTools(connection.id);
    const cached = this.toolInventories.get(connection.id);
    if (cached) return cached;
    const pending = this.toolInventoryReads.get(connection.id);
    if (pending) return await pending;
    const generation = this.toolInventoryCacheGenerations.get(connection.id) ?? 0;
    const read = this.readConnectionTools(connection, generation).finally(() => {
      if (this.toolInventoryReads.get(connection.id) === read) {
        this.toolInventoryReads.delete(connection.id);
      }
    });
    this.toolInventoryReads.set(connection.id, read);
    return await read;
  }

  private invalidateConnectionTools(connectionId: string): void {
    this.evictConnectionToolInventory(connectionId);
    this.toolInventoryGenerations.set(
      connectionId,
      (this.toolInventoryGenerations.get(connectionId) ?? 0) + 1,
    );
  }

  private evictConnectionToolInventory(connectionId: string): void {
    const health = this.discoveryHealth.get(connectionId);
    if (health) this.discoveryHealth.set(connectionId, { ...health, state: "untested" });
    this.toolInventories.delete(connectionId);
    this.toolInventoryReads.delete(connectionId);
    this.toolInventoryCacheGenerations.set(
      connectionId,
      (this.toolInventoryCacheGenerations.get(connectionId) ?? 0) + 1,
    );
  }

  private async readConnectionTools(
    connection: McpConnectionRecord,
    generation: number,
  ): Promise<ListMcpConnectionToolsResponse> {
    const discovery = new McpDiscovery(connection.id, Date.now() + MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS);
    let session: UpstreamSession | undefined;
    try {
      session = await discovery.phase("initialize", async () => await this.connectUpstreamClient(connection, {
        clientName: `pwragent-${connection.id}-settings`,
        discovery,
      }));
      const tools: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
        const result = await discovery.phase("tools/list", async () => await session!.client.listTools(
          cursor ? { cursor } : undefined,
          { timeout: discovery.remaining(), signal: discovery.signal },
        ), page + 1);
        tools.push(...result.tools.map((tool) => tool.name));
        cursor = result.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || page === MAX_TOOL_LIST_PAGES - 1) {
          throw new Error("The MCP catalog could not be completely paged.");
        }
        cursors.add(cursor);
      }
      const inventory: ListMcpConnectionToolsResponse = {
        connectionId: connection.id,
        tools,
        fetchedAt: Date.now(),
      };
      if ((this.toolInventoryCacheGenerations.get(connection.id) ?? 0) === generation) {
        this.toolInventories.set(connection.id, inventory);
        this.recordDiscoverySuccess(connection.id);
      }
      return inventory;
    } catch (error) {
      if ((this.toolInventoryCacheGenerations.get(connection.id) ?? 0) === generation) this.recordDiscoveryFailure(connection.id, error);
      throw error;
    } finally {
      discovery.close();
      if (session) await session.client.close().catch(async () => {
        await session!.transport.close().catch(() => undefined);
      });
    }
  }

  async removeConnection(connectionId: string): Promise<boolean> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      const removed = await this.requestOwnerBroker<boolean>(
        ownership.holder,
        "broker/remove",
        { connectionId },
      );
      this.announceChanged([connectionId]);
      return removed;
    }
    if (isBuiltInMcpConnectionId(connectionId)) {
      throw new Error("Built-in MCP connections cannot be removed.");
    }
    const connection = this.requireConnection(connectionId);
    await this.closeConnectionSessions(connectionId);
    if (connection.kind === "stdio") {
      this.invalidateConnectionTools(connectionId);
      this.discoveryHealth.delete(connectionId);
      // Secrets first: if storage refuses, the row stays and Remove can be
      // tried again, rather than leaving a token with no row to reach it.
      await this.stdioSecrets.delete(connectionId);
      const removed = this.registry.remove(connectionId);
      this.announceChanged([connectionId]);
      return removed;
    }
    if (isMcpIpcUrl(connection.serverUrl)) await this.credentialVault.delete(connection.id);
    if (connection.authMode === "oauth") await this.coordinatorFor(connection).disconnect();
    this.coordinators.delete(connectionId);
    this.invalidateConnectionTools(connectionId);
    const removed = this.registry.remove(connectionId);
    this.announceChanged([connectionId]);
    return removed;
  }

  async registerBridge(
    connectionId: string,
    threadId?: string,
    signal?: AbortSignal,
    /** The backend of a bare thread id, so its roots can be read. */
    backend?: AppServerBackendKind,
  ): Promise<McpConnectionBridgeRegistration> {
    const registration = await this.registerBridgeScope(connectionId, threadId, signal, backend);
    this.noteRootThread(threadId, backend);
    return registration;
  }

  private async registerBridgeScope(
    connectionId: string,
    threadId: string | undefined,
    signal: AbortSignal | undefined,
    backend: AppServerBackendKind | undefined,
  ): Promise<McpConnectionBridgeRegistration> {
    signal?.throwIfAborted();
    const ownership = await this.ensureOwnerBroker();
    signal?.throwIfAborted();
    if (!ownership.owned) {
      return await this.registerOwnerBridge(
        ownership.holder,
        connectionId,
        threadId,
        signal,
        backend,
      );
    }
    // Availability is checked before credentials: a connection withheld by
    // the gateway switch or by its own switch is not an authorization
    // problem, and telling the operator to reauthorize would send them to
    // the wrong control.
    const connection = this.requireAvailableConnection(connectionId);
    const status = await this.connectionStatus(connection);
    const configured = status.configured;
    signal?.throwIfAborted();
    if (!configured) {
      throw new Error(
        connection.authMode === "local_cli" || runsLocalProcess(connection) ? status.detail
          : `${connection.displayName} is not connected to PwrAgent. Reauthorize it in Settings → Plugins.`,
      );
    }
    const registrationKey = threadId
      ? `${connectionId}:${threadId}`
      : undefined;
    const existing = registrationKey
      ? this.threadRegistrations.get(registrationKey)
      : undefined;
    if (existing && this.grants.has(existing.token)) {
      this.adoptGrantBackend(existing.token, backend);
      return this.registrationHandle(existing.token, existing.server, registrationKey, backend);
    }
    await this.startBridgeServer();
    signal?.throwIfAborted();
    // Another call may have registered this same scope during broker startup.
    const started = registrationKey ? this.threadRegistrations.get(registrationKey) : undefined;
    if (started && this.grants.has(started.token)) {
      this.adoptGrantBackend(started.token, backend);
      return this.registrationHandle(started.token, started.server, registrationKey, backend);
    }
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, { connectionId, threadId, ...(backend ? { backend } : {}) });
    const socketPath = this.bridgeSocketPath;
    if (!socketPath) {
      this.grants.delete(token);
      this.relayGrantEpochs.delete(token);
      throw new Error("The PwrAgent MCP bridge is unavailable.");
    }
    const server = this.buildBridgeServer(connectionId, token, socketPath);
    if (registrationKey) {
      this.threadRegistrations.set(registrationKey, { server, token });
    }
    return this.registrationHandle(token, server, registrationKey, backend);
  }

  /** A grant registered before its backend was known learns it once. */
  private adoptGrantBackend(token: string, backend: AppServerBackendKind | undefined): void {
    const grant = this.grants.get(token);
    if (grant && backend && !grant.backend) grant.backend = backend;
  }

  /** Host callers authorize the live thread selection before entering this seam.
   * The owner broker independently enforces credentials, availability and schema.
   * Reuse the revocable connection transport, including across profile instances.
   */
  async requestGatewayToolOperation(params: {
    connectionId: string;
    scopeKey: string;
    operation: "gateway/tools/list" | "gateway/tools/call";
    invocation?: McpGatewayInvocation;
    signal: AbortSignal;
    deadlineAt?: number;
    /** Shows the upstream server's forms for a call to the thread's operator. */
    elicit?: ElicitationRoute;
    /** `elicit` can also show the upstream server's links. */
    elicitUrl?: boolean;
    /** Called for each progress report from the upstream server during a call. */
    onProgress?: () => void;
  }): Promise<McpGatewayTool[] | CallToolResult> {
    params.signal.throwIfAborted();
    const discovery = new McpDiscovery(params.connectionId, params.deadlineAt ?? Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS, params.signal);
    try {
      const registration = await discovery.phase("registration", async () => await this.registerBridge(params.connectionId, params.scopeKey, discovery.signal), undefined, true);
      params.signal.throwIfAborted();
      const rpc = new ConnectionRpcClient(
        registration.server.env.PWRAGENT_MCP_CONNECTION_SOCKET,
        registration.server.env.PWRAGENT_MCP_CONNECTION_TOKEN,
      );
      // The owner still needs the discovery deadline for catalog validation.
      // A call's socket must also cover execution after that validation ends.
      const call = params.operation === "gateway/tools/call";
      return await rpc.request(
        params.operation, params.invocation, params.signal, discovery.deadlineAt, discovery.id,
        call ? MCP_CONNECTION_TOOL_TIMEOUT_MS : undefined,
        call ? params.elicit : undefined,
        call ? params.onProgress : undefined,
        call && params.elicit && params.elicitUrl ? { urlElicitation: true } : undefined,
      ) as McpGatewayTool[] | CallToolResult;
    } finally {
      discovery.close();
    }
  }

  private registrationHandle(
    token: string,
    server: McpConnectionBridgeServer,
    registrationKey?: string,
    backend?: AppServerBackendKind,
  ): McpConnectionBridgeRegistration {
    let currentRegistrationKey = registrationKey;
    return {
      server,
      bindThread: (threadId) => {
        const grant = this.grants.get(token);
        if (!grant) return;
        grant.threadId = threadId;
        currentRegistrationKey = `${grant.connectionId}:${threadId}`;
        this.threadRegistrations.set(
          currentRegistrationKey,
          { server, token },
        );
        this.announceGrantRoots(token, grant);
        this.noteRootThread(threadId, grant.backend ?? backend);
      },
      revoke: () => {
        const connectionId = this.grants.get(token)?.connectionId;
        this.grants.delete(token);
        this.relayGrantEpochs.delete(token);
        void this.closeUpstreamSession(token, true, connectionId);
        if (currentRegistrationKey && this.threadRegistrations.get(currentRegistrationKey)?.token === token) {
          this.threadRegistrations.delete(currentRegistrationKey);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.grants.clear();
    this.relayGrantEpochs.clear();
    this.threadRegistrations.clear();
    for (const sockets of this.bridgeAttachments.values()) {
      for (const socket of sockets) socket.destroy();
    }
    this.bridgeAttachments.clear();
    this.bridgeAttachmentCount = 0;
    await Promise.all([...this.stdioTestTransports].map(async (transport) =>
      await transport.close().catch(() => undefined)));
    this.stdioTestTransports.clear();
    await Promise.all([
      ...[...new Set([...this.upstreamSessions.keys(), ...this.upstreamStarts.keys()])].map(async (token) =>
        await this.closeUpstreamSession(token),
      ),
      ...[...this.relayPools.keys()].map(async (connectionId) => await this.closeRelayPool(connectionId)),
    ]);
    const server = this.bridgeServer;
    this.bridgeServer = undefined;
    this.bridgeSocketPath = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const directory = this.bridgeSocketDirectory;
    this.bridgeSocketDirectory = undefined;
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (this.leaseHeld) {
      if (this.leaseManager) {
        try {
          this.brokerDiscovery.clear(this.leaseManager.id);
        } catch (error) {
          connectionLog.warn("MCP broker discovery cleanup failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.leaseManager?.release("mcp_connections");
      this.leaseHeld = false;
      this.brokerToken = undefined;
    }
  }

  async start(): Promise<void> {
    const ownership = this.claimProfileOwnership();
    if (!ownership.owned) {
      this.readOwnerBrokerRecord(ownership.holder);
      return;
    }
    try {
      await this.startBridgeServer();
    } catch (error) {
      this.releaseOwnershipAfterBrokerFailure();
      throw error;
    }
  }

  private claimProfileOwnership(): ProfileOwnership {
    // Status reads also start the broker on demand. During onboarding there
    // is no active profile: publishing discovery would create profiles/default
    // even when the operator is provisioning only named profiles.
    if (getAppStateMode() === "bootstrap") {
      throw new Error("Complete profile setup before using managed MCP connections.");
    }
    if (!this.leaseManager || this.leaseHeld) return { owned: true };
    if (
      this.nonOwnerHolder
      && !this.leaseManager.shouldRetryAcquisition("mcp_connections")
    ) {
      // A different instance may have taken over since the last request.
      // Keep the dead holder during its safety grace, but refresh a live one.
      const holder = this.leaseManager.snapshot("mcp_connections").leaseHolder;
      if (holder) this.nonOwnerHolder = holder;
      return { owned: false, holder: this.nonOwnerHolder };
    }
    const result = this.leaseManager.acquire("mcp_connections");
    if (!result.acquired) {
      this.nonOwnerHolder = result.holder;
      return { owned: false, holder: result.holder };
    }
    this.nonOwnerHolder = undefined;
    this.leaseHeld = true;
    this.brokerToken = randomBytes(32).toString("base64url");
    return { owned: true };
  }

  private async ensureOwnerBroker(): Promise<ProfileOwnership> {
    const ownership = this.claimProfileOwnership();
    if (ownership.owned && this.leaseManager && this.leaseHeld) {
      try {
        await this.startBridgeServer();
      } catch (error) {
        this.releaseOwnershipAfterBrokerFailure();
        throw error;
      }
    }
    return ownership;
  }

  private releaseOwnershipAfterBrokerFailure(): void {
    this.leaseManager?.release("mcp_connections");
    this.leaseHeld = false;
    this.brokerToken = undefined;
  }

  private readOwnerBrokerRecord(
    holder: RuntimeLeaseHolder,
  ): McpConnectionBrokerRecord {
    const record = this.brokerDiscovery.read();
    if (!record || record.ownerInstanceId !== holder.instanceId) {
      this.nonOwnerHolder = undefined;
      throw new Error(
        "The MCP connection owner has not published a valid local broker endpoint.",
      );
    }
    return record;
  }

  private async requestOwnerBroker<T>(
    holder: RuntimeLeaseHolder,
    operation: string,
    params?: unknown,
    maxResponseBytes?: number,
  ): Promise<T> {
    try {
      return await this.requestBrokerRecord<T>(
        this.readOwnerBrokerRecord(holder),
        operation,
        params,
        undefined,
        maxResponseBytes,
      );
    } catch (error) {
      this.nonOwnerHolder = undefined;
      throw error;
    }
  }

  private requestBrokerRecord<T>(
    record: McpConnectionBrokerRecord,
    operation: string,
    params?: unknown,
    signal?: AbortSignal,
    maxResponseBytes = MAX_RPC_LINE_BYTES,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const socket = connect(record.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      const timeout = setTimeout(
        () => finish(this.ownerUnavailableError()),
        MCP_CONNECTION_TOOL_TIMEOUT_MS,
      );
      timeout.unref();
      const onAbort = (): void => finish(signal?.reason ?? new DOMException("The MCP broker request was cancelled.", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({
          brokerToken: record.brokerToken,
          op: operation,
          ...(params === undefined ? {} : { params }),
        })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > maxResponseBytes) {
          finish(new Error("The MCP connection owner response was too large."));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as BridgeResponse;
          if (!response.ok) {
            finish(new Error(response.error));
            return;
          }
          finish(undefined, response.result as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        // A refused or missing socket is an owner that exited without
        // releasing its lease. The lease stays with it for the dead-owner
        // grace, so the raw error — a temp socket path — reaches every
        // screen that lists connections until another instance takes over.
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
          finish(this.ownerUnavailableError(error));
          return;
        }
        finish(error);
      });
      socket.on("close", () => {
        finish(new Error("The MCP connection owner closed unexpectedly."));
      });
    });
  }

  private ownerUnavailableError(cause?: Error): Error {
    const profile = this.leaseManager?.profile ?? resolveActiveProfileName();
    return new Error(
      `MCP connections for PwrAgent profile "${profile}" are temporarily unavailable: its managing instance is not responding.`,
      { cause },
    );
  }

  private async registerOwnerBridge(
    holder: RuntimeLeaseHolder,
    connectionId: string,
    threadId?: string,
    signal?: AbortSignal,
    backend?: AppServerBackendKind,
  ): Promise<McpConnectionBridgeRegistration> {
    let record: McpConnectionBrokerRecord;
    let result: { token: string };
    try {
      record = this.readOwnerBrokerRecord(holder);
      result = await this.requestBrokerRecord<{ token: string }>(
        record,
        "broker/register",
        { connectionId, threadId, ...(backend ? { backend } : {}) },
        signal,
      );
    } catch (error) {
      this.nonOwnerHolder = undefined;
      throw error;
    }
    const server = this.buildBridgeServer(
      connectionId,
      result.token,
      record.socketPath,
    );
    return {
      server,
      bindThread: (nextThreadId) => {
        void this.requestBrokerRecord(
          record,
          "broker/bind",
          { threadId: nextThreadId, token: result.token },
        ).catch((error) => {
          connectionLog.warn("remote MCP bridge bind failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.noteRootThread(nextThreadId, backend);
      },
      revoke: () => {
        void this.requestBrokerRecord(
          record,
          "broker/revoke",
          { token: result.token },
        ).catch(() => undefined);
      },
    };
  }

  private buildBridgeServer(
    connectionId: string,
    token: string,
    socketPath: string,
  ): McpConnectionBridgeServer {
    return {
      name: connectionId,
      command: process.execPath,
      args: [this.bridgeEntryPath],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PWRAGENT_MCP_CONNECTION_NAME: connectionId,
        PWRAGENT_MCP_CONNECTION_SOCKET: socketPath,
        PWRAGENT_MCP_CONNECTION_TOKEN: token,
      },
    };
  }

  private async connectNow(): Promise<ConnectPwrSnapResponse> {
    const status = await this.readStatus();
    if (status.availability !== "not_installed" && !status.configured) {
      return { outcome: "needs_update", status };
    }
    if (status.availability !== "running") {
      return { outcome: "needs_local_agent_access", status };
    }
    await this.authorizeConnection(PWRSNAP_MCP_CONNECTION_ID);
    return { outcome: "connected", status };
  }

  private async createOAuthCallback(
    expectedState: string,
    displayName: string,
    connectionId: string,
  ): Promise<{
    url: URL;
    waitForCode: () => Promise<string>;
    complete: (state: "connected" | "failed", detail: string) => void;
    abandon: (reason: string) => void;
    close: () => Promise<void>;
  }> {
    let resolveRequest: ((url: URL) => void) | undefined;
    let rejectRequest: ((error: Error) => void) | undefined;
    const requestPromise = new Promise<URL>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    /*
     * `abandon` can reject this before `waitForCode` is ever awaited -- a
     * cancel during OAuth discovery, or a retry that replaces an attempt
     * still in `authFn`. Without a handler attached at creation that is an
     * unhandled rejection, which crashes the main process under Node's
     * default policy. `waitForCode` still sees the rejection: this marks the
     * promise handled, it does not consume it.
     */
    requestPromise.catch(() => {});
    let callbackState: {
      state: "connecting" | "connected" | "failed";
      detail: string;
    } = {
      state: "connecting",
      detail: "PwrAgent is exchanging the approved authorization for a secure local connection.",
    };
    const server: HttpServer = createHttpServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
      if (requestUrl.pathname === "/oauth/status") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify(callbackState));
        return;
      }
      const markName = requestUrl.pathname.startsWith("/assets/")
        && requestUrl.pathname.endsWith(".png")
        ? requestUrl.pathname.slice("/assets/".length, -".png".length)
        : undefined;
      if (markName !== undefined && isBrandedMark(markName)) {
        const asset = connectionAsset(markName);
        if (asset === null) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "cache-control": "public, max-age=3600",
          "content-type": "image/png",
        });
        response.end(asset);
        return;
      }
      if (requestUrl.pathname !== "/oauth/callback") {
        response.writeHead(404).end();
        return;
      }
      // The state check gates both outcomes, not only success. This server
      // listens on a loopback port any local process can find, and an
      // unchecked `?error=` would let one abort a pending authorization
      // while the operator is still completing consent in the browser.
      if (requestUrl.searchParams.get("state") !== expectedState) {
        callbackState = {
          state: "failed",
          detail: "The authorization state did not match.",
        };
        response.writeHead(400, callbackHtmlHeaders());
        response.end(
          htmlResponse(
            `${displayName} connection rejected`,
            "The authorization state did not match.",
            { connectionId, displayName },
          ),
        );
        rejectRequest?.(new Error(`${displayName} authorization state did not match.`));
        return;
      }
      const error = requestUrl.searchParams.get("error");
      if (error) {
        const detail =
          requestUrl.searchParams.get("error_description") ?? error;
        callbackState = { state: "failed", detail };
        response.writeHead(400, callbackHtmlHeaders());
        response.end(htmlResponse(`${displayName} connection declined`, detail, {
          connectionId,
          displayName,
        }));
        rejectRequest?.(new Error(detail));
        return;
      }
      response.writeHead(200, callbackHtmlHeaders());
      response.end(
        htmlResponse(
          `Connecting PwrAgent to ${displayName}`,
          `${displayName} approved the request. PwrAgent is finishing the secure connection.`,
          { connectionId, displayName, liveStatus: true },
        ),
      );
      resolveRequest?.(requestUrl);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error(`Could not start the ${displayName} OAuth callback.`);
    }
    return {
      url: new URL(`http://127.0.0.1:${address.port}/oauth/callback`),
      waitForCode: async () => {
        const timeout = setTimeout(() => {
          rejectRequest?.(new Error(`${displayName} authorization timed out.`));
        }, OAUTH_CALLBACK_TIMEOUT_MS);
        try {
          const requestUrl = await requestPromise;
          const code = requestUrl.searchParams.get("code");
          if (!code) {
            throw new Error(`${displayName} did not return an authorization code.`);
          }
          return code;
        } finally {
          clearTimeout(timeout);
        }
      },
      complete: (state, detail) => {
        callbackState = { state, detail };
      },
      /*
       * Fail the wait now instead of at the callback timeout.
       *
       * `authorizeConnection`'s `finally` runs `close` off the rejection, so
       * this is what actually frees the port. `server.close()` is called
       * directly rather than left to `close`'s 30s grace: the grace exists so
       * a browser that arrives a moment after a *successful* exchange still
       * gets the completion page, and there is no completion to show for an
       * attempt nobody is waiting on.
       */
      abandon: (reason: string) => {
        callbackState = { state: "failed", detail: reason };
        rejectRequest?.(new Error(reason));
        server.close();
      },
      close: async () => {
        server.unref();
        const timer = setTimeout(() => server.close(), 30_000);
        timer.unref();
      },
    };
  }

  private findInstalledPath(): string | undefined {
    return this.resolveInstallPaths().find((candidate) => existsSync(candidate));
  }

  private async isRelayAppListening(app: PwrSuiteRelayApp): Promise<boolean> {
    try {
      return await (app === "pwrsnap" ? this.isPwrSnapListening() : this.isPwrGitListening());
    } catch {
      return false;
    }
  }

  /** The relay inside the first install of the app that has one. */
  private findRelay(app: PwrSuiteRelayApp): string | undefined {
    return findPwrSuiteRelay(
      app,
      app === "pwrsnap" ? this.resolveInstallPaths() : this.resolvePwrGitInstallPaths(),
    );
  }

  /**
   * What PwrAgent starts for a PwrSnap or PwrGit session: the relay the app
   * ships, with no arguments. The relay finds the app's socket or pipe itself.
   */
  private relayLaunch(app: PwrSuiteRelayApp): McpStdioLaunch {
    const relay = this.findRelay(app);
    if (!relay) throw new McpStdioLaunchError("not_found", pwrSuiteUpdateDetail(app));
    return { command: relay, args: [], env: [] };
  }

  /**
   * Resolve a connection for management.
   *
   * Existence is the only test here. Availability deliberately is not: an
   * operator must be able to re-enable, reauthorize, or remove a connection
   * they have parked, and folding the `enabled` check into this lookup would
   * make a disabled connection permanently unmanageable.
   */
  private requireConnection(connectionId: string): McpConnectionRecord {
    const connection = this.registry.get(connectionId);
    if (!connection) {
      throw new Error(`Unknown MCP connection: ${connectionId}`);
    }
    return connection;
  }

  /**
   * Resolve a connection that is allowed to serve a thread right now.
   *
   * This is the enforcement point for both the profile-wide gateway switch
   * and a connection's own availability, so no bridge can be handed to a
   * thread that the operator has switched off.
   */
  private requireAvailableConnection(connectionId: string): McpConnectionRecord {
    if (!this.gatewayEnabled()) {
      throw new Error(GATEWAY_OFF_ERROR);
    }
    const connection = this.requireConnection(connectionId);
    if (!connection.enabled) {
      throw new Error(
        `${connection.displayName} is not available to threads. Turn it on in Settings → Plugins.`,
      );
    }
    return connection;
  }

  /**
   * Hand an OAuth authorization URL to the OS.
   *
   * The URL comes from the remote server's `authorization_endpoint`, and the
   * SDK only screens it against a three-scheme denylist — `ms-msdt:`, `smb:`,
   * and `file:` all survive that. `shell.openExternal` would launch the local
   * handler for any of them, so the URL has to clear the same gate every
   * other external open in the app clears, narrowed to the two schemes an
   * authorization endpoint can legitimately use.
   */
  private async openAuthorizationUrl(url: URL): Promise<void> {
    const allowedScheme = url.protocol === "https:" || url.protocol === "http:";
    if (!allowedScheme || !isSafeExternalOpenUrl(url.href)) {
      throw new Error(
        "The MCP server asked PwrAgent to open an unsupported authorization URL.",
      );
    }
    await this.openExternal(url.href);
  }

  private coordinatorFor(
    connection: McpConnectionRecord,
  ): McpOAuthSessionCoordinator {
    if (connection.authMode !== "oauth") throw new Error("This connection uses the local CLI login, not OAuth.");
    let coordinator = this.coordinators.get(connection.id);
    if (!coordinator) {
      const serverUrl = new URL(connection.serverUrl);
      coordinator = new McpOAuthSessionCoordinator({
        connectionId: connection.id,
        serverUrl,
        ...(connection.kind === "sandboxer" ? { scope: "sandboxer" } : {}),
        vault: this.credentialVault,
        fetchFn: createMcpSafeFetch({
          fetchFn: this.fetchFn,
          connectionId: connection.id,
        }),
        onStateChange: (state) => {
          connectionLog.info("MCP connection state changed", {
            connectionId: connection.id,
            state,
          });
        },
      });
      this.coordinators.set(connection.id, coordinator);
    }
    return coordinator;
  }

  private recordDiscoverySuccess(connectionId: string): void {
    this.discoveryHealth.set(connectionId, {
      ...this.discoveryHealth.get(connectionId), state: "ready", lastSuccessAt: Date.now(),
    });
  }

  private recordDiscoveryFailure(connectionId: string, error: unknown): void {
    if (!isMcpDiscoveryError(error)) return;
    const data = error.data as { kind?: string };
    if (data.kind === "cancelled") return;
    this.discoveryHealth.set(connectionId, {
      ...this.discoveryHealth.get(connectionId), state: "failed",
      lastFailure: { at: Date.now(), message: error.message },
    });
  }

  private async connectionStatus(
    connection: McpConnectionRecord,
    cachedLocalStatus = false,
    sandboxerStatusMaxAgeMs?: number,
  ): Promise<McpConnectionStatus> {
    if (isMcpIpcUrl(connection.serverUrl)) {
      return {
        ...connection, configured: true, state: "ready",
        discovery: this.discoveryHealth.get(connection.id) ?? { state: "untested" },
      };
    }
    if (connection.kind === "sandboxer" && connection.authMode === "local_cli") {
      // New-thread defaults have a two-second total budget. Refresh enabled
      // compute in the background without delaying unrelated defaults. A cold
      // cache skips only Sandboxer until a probe has established its login.
      if (cachedLocalStatus && connection.enabled) {
        void this.sandboxer.readStatus();
      }
      const status = cachedLocalStatus
        ? this.sandboxer.cachedStatus()
        : await this.sandboxer.readStatus(
          sandboxerStatusMaxAgeMs === undefined
            ? false
            : { maxAgeMs: sandboxerStatusMaxAgeMs },
        );
      return {
        ...connection,
        ...status,
        discovery: this.discoveryHealth.get(connection.id) ?? { state: "untested" },
      };
    }
    if (connection.kind === "stdio") return await this.stdioConnectionStatus(connection);
    if (isPwrSuiteRelayKind(connection.kind)) {
      // Configured means this machine has an install with the relay. Whether
      // the app is open is the New thread card's question, asked live.
      const relay = this.findRelay(connection.kind);
      const running = this.stdioProcessCounts.get(connection.id) ?? 0;
      return {
        ...connection,
        configured: relay !== undefined,
        state: "ready",
        ...(relay ? {} : { detail: pwrSuiteUpdateDetail(connection.kind) }),
        ...(running > 0 ? { localProcesses: running } : {}),
        discovery: this.discoveryHealth.get(connection.id) ?? { state: "untested" },
      };
    }
    const coordinator = this.coordinatorFor(connection);
    const configured = await coordinator.configured();
    return {
      ...connection,
      configured,
      discovery: this.discoveryHealth.get(connection.id) ?? { state: "untested" },
      state: configured ? coordinator.state : "disconnected",
      ...(coordinator.detail ? { detail: coordinator.detail } : {}),
    };
  }

  /**
   * A local command is configured when every secret it names can be read
   * back. There is no sign-in, so its state is otherwise always ready; a
   * server that fails to start says so through its discovery health.
   */
  private async stdioConnectionStatus(connection: McpConnectionRecord): Promise<McpConnectionStatus> {
    const secretNames = (connection.stdio?.env ?? []).filter((entry) => entry.secret).map((entry) => entry.name);
    let detail: string | undefined;
    if (secretNames.length > 0) {
      try {
        const stored = await this.stdioSecrets.read(connection.id);
        const missing = secretNames.find((name) => !Object.hasOwn(stored, name));
        if (missing) {
          detail = `PwrAgent could not read the stored value of ${missing}. Edit this connection and enter it again.`;
        }
      } catch {
        detail = "PwrAgent could not read this server's stored secrets. Edit this connection and enter them again.";
      }
    }
    const running = this.stdioProcessCounts.get(connection.id) ?? 0;
    return {
      ...connection,
      configured: detail === undefined,
      state: "ready",
      ...(detail ? { detail } : {}),
      ...(running > 0 ? { localProcesses: running } : {}),
      discovery: this.discoveryHealth.get(connection.id) ?? { state: "untested" },
    };
  }

  private async ensureUpstreamClient(
    token: string,
    grant: BridgeGrant,
    discovery: McpDiscovery,
    request: { operation: unknown; delegated: boolean; uri?: string },
  ): Promise<{ client: Client; release?: () => void }> {
    const connection = this.requireAvailableConnection(grant.connectionId);
    discovery.remaining();
    if (isPwrSuiteRelayKind(connection.kind)) {
      return await this.acquireRelaySession(token, grant, connection, connection.kind, discovery, request);
    }
    const existing = this.upstreamSessions.get(token);
    if (existing) return { client: existing.client };
    if (this.disconnectedStdioGrants.has(token)) throw new Error(ENDED_LOCAL_SESSION_ERROR);
    let pending = this.upstreamStarts.get(token);
    if (!pending) {
      const controller = new AbortController();
      const startDiscovery = new McpDiscovery(connection.id, Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS, controller.signal);
      const start = { controller, waiters: 0, discoveryId: startDiscovery.id, promise: undefined as unknown as Promise<Client> };
      start.promise = startDiscovery.phase("initialize", async () => await this.openUpstreamSession(token, connection, startDiscovery)).catch((error: unknown) => {
        // A command can exit before initialization registers its session.
        // Discovery must not repeatedly launch that command (or its consent
        // window). An operator reconnect or launch-config edit permits a new
        // attempt. Cancellation by the last waiter is not a server failure.
        if (connection.kind === "stdio" && !controller.signal.aborted && this.grants.get(token) === grant) {
          this.disconnectedStdioGrants.add(token);
        }
        throw error;
      }).finally(() => {
        startDiscovery.close();
        if (this.upstreamStarts.get(token) === start) this.upstreamStarts.delete(token);
      });
      pending = start;
      this.upstreamStarts.set(token, start);
    }
    const start = pending;
    start.waiters += 1;
    connectionLog.info("MCP initialization waiter joined", {
      connectionId: grant.connectionId, discoveryId: discovery.id, startDiscoveryId: start.discoveryId,
    });
    try {
      const client = await discovery.phase("initialize", async () => await waitForMcp(start.promise, discovery.signal));
      // A live session is not an ended one. A session that closed already
      // has marked the grant again, and is no longer registered here.
      if (this.upstreamSessions.get(token)?.client === client) this.disconnectedStdioGrants.delete(token);
      return { client };
    } finally {
      start.waiters -= 1;
      if (start.waiters === 0 && this.upstreamStarts.get(token) === start) {
        this.upstreamStarts.delete(token);
        start.controller.abort(new DOMException("All MCP initialization waiters left.", "AbortError"));
      }
    }
  }

  /**
   * A PwrSnap or PwrGit session from the connection's shared pool.
   *
   * A tool call holds its session until `release`, so a question the server
   * asks mid-call has exactly one caller to go to. A second concurrent tool
   * call opens another session. Anything else shares any open session, except
   * a read of a PwrSnap image link, which only the session that returned it
   * can serve.
   */
  private async acquireRelaySession(
    token: string,
    grant: BridgeGrant,
    connection: McpConnectionRecord,
    kind: PwrSuiteRelayApp,
    discovery: McpDiscovery,
    request: { operation: unknown; delegated: boolean; uri?: string },
  ): Promise<{ client: Client; release?: () => void }> {
    const entry = this.relayPoolFor(connection);
    if (request.uri !== undefined) {
      const threadId = grantThreadId(grant) ?? "";
      const owner = this.pwrSnapMediaLinks.resolve(threadId, request.uri, {
        isLive: (candidate, session) => candidate === token && entry.pool.has(session as Client),
        threadOf: (candidate) => candidate === token ? threadId : undefined,
      });
      if (owner) return { client: owner.session as Client };
    }
    if (entry.pool.ended && entry.pool.size === 0 && !entry.pool.isOpening) {
      const outcome = await endedLocalSessionRestart({
        kind,
        operation: request.operation,
        delegated: request.delegated,
        isAppListening: async () => await this.isRelayAppListening(kind),
      });
      if (outcome !== "restart") throw new Error(endedRelaySessionError(kind, outcome));
      discovery.remaining();
    }
    const toolCall = request.operation === "tools/call" || request.operation === "gateway/tools/call";
    return await discovery.phase("initialize", async () => {
      if (!toolCall) return { client: await entry.pool.shared(discovery.signal) };
      const lease = await entry.pool.exclusive(token, discovery.signal);
      return { client: lease.session, release: lease.release };
    });
  }

  private relayPoolFor(connection: McpConnectionRecord): { pool: RelaySessionPool<Client>; identity: string } {
    const existing = this.relayPools.get(connection.id);
    if (existing) return existing;
    const pool: RelaySessionPool<Client> = new RelaySessionPool<Client>({
      max: MAX_RELAY_SESSIONS,
      open: async (signal): Promise<Client> => await this.openRelaySession(connection, pool, signal),
      close: async (client) => await this.closeRelayClient(client),
    });
    const entry = { identity: randomUUID(), pool };
    this.relayPools.set(connection.id, entry);
    return entry;
  }

  private async openRelaySession(
    connection: McpConnectionRecord,
    pool: RelaySessionPool<Client>,
    signal: AbortSignal,
  ): Promise<Client> {
    const generation = this.toolInventoryGenerations.get(connection.id) ?? 0;
    const discovery = new McpDiscovery(connection.id, Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS, signal);
    try {
      // Awaited directly, not abandoned on abort: a session that finishes
      // opening after the pool closed is closed below, never leaked.
      const session = await this.connectUpstreamClient(connection, {
        clientName: `pwragent-${connection.id}-proxy`,
        discovery,
        threadSession: true,
        handlers: {
          // A server asks only on behalf of the tool call holding the session.
          onElicit: async (client, request, signal) => {
            const holder = pool.holderOf(client);
            if (!holder) {
              throw elicitationUnavailable("No PwrAgent tool call is waiting on this MCP session, so no one can answer its form.");
            }
            return await this.routeUpstreamElicitation(holder, client, request, signal);
          },
          onElicitationComplete: (client, elicitationId) => {
            const opener = this.openedUrlElicitations.get(client)?.get(elicitationId);
            if (opener) this.completeUpstreamUrlElicitation(opener, client, elicitationId);
          },
        },
        onClose: (client) => {
          if (!pool.has(client)) return;
          pool.remove(client);
          this.pwrSnapMediaLinks.forgetSession(client);
          // Another open session still serves the same catalog.
          if (pool.size === 0) this.evictConnectionToolInventory(connection.id);
        },
      });
      if (signal.aborted
        || generation !== (this.toolInventoryGenerations.get(connection.id) ?? 0)
        || !this.gatewayEnabled()
        || !this.registry.get(connection.id)?.enabled) {
        await session.client.close();
        throw new Error("The MCP connection changed while its session was opening. Retry discovery.");
      }
      this.relaySessions.set(session.client, session);
      return session.client;
    } finally {
      discovery.close();
    }
  }

  private async closeRelayClient(client: Client): Promise<void> {
    this.pwrSnapMediaLinks.forgetSession(client);
    const session = this.relaySessions.get(client);
    await client.close().catch(async () => {
      await session?.transport.close().catch(() => undefined);
    });
  }

  /** Close a connection's shared sessions; the next request builds a new pool. */
  private async closeRelayPool(connectionId: string): Promise<void> {
    const entry = this.relayPools.get(connectionId);
    if (!entry) return;
    this.relayPools.delete(connectionId);
    await entry.pool.close();
  }

  /** What a catalog revision read through `client` for `token` is tied to. */
  private sessionRevisionKey(token: string, connectionId: string, client: Client): unknown {
    const entry = this.relayPools.get(connectionId);
    if (!entry?.pool.has(client)) return this.sessionIdentities.get(client);
    return [entry.identity, this.relayGrantEpochs.get(token) ?? ""];
  }

  /**
   * Whether a grant other than `except` still uses a connection's shared
   * sessions: a thread whose bridge is attached, or PwrAgent's own gateway,
   * whose grants call through no bridge.
   */
  private relayHasOtherUser(connectionId: string, except: string): boolean {
    for (const [token, grant] of this.grants) {
      if (token === except || grant.connectionId !== connectionId) continue;
      if (grant.threadId?.startsWith("[\"gateway\"")) return true;
      if ((this.bridgeAttachments.get(token)?.size ?? 0) > 0) return true;
    }
    return false;
  }

  /** Whether `client` is the session `token` is using now. */
  private isCurrentUpstream(token: string, client: Client): boolean {
    const grant = this.grants.get(token);
    if (!grant) return false;
    if (this.relayPools.get(grant.connectionId)?.pool.has(client)) return true;
    return this.upstreamSessions.get(token)?.client === client;
  }

  private sendBridgeEvent(token: string, event: { method: string; params?: unknown }): void {
    const line = `${JSON.stringify({ event })}\n`;
    for (const socket of this.bridgeAttachments.get(token) ?? []) {
      // A stalled bridge cannot retain an unbounded notification queue.
      if (socket.writableLength + Buffer.byteLength(line) > MAX_RPC_LINE_BYTES) socket.destroy();
      else socket.write(line);
    }
  }

  private installDiscoveryNotifications(client: Client, connection: McpConnectionRecord): void {
    const forward = (notification: Notification): void => {
      const caps = client.getServerCapabilities();
      const method = notification.method;
      const supported = method === "notifications/tools/list_changed" ? caps?.tools?.listChanged
        : method === "notifications/prompts/list_changed" ? caps?.prompts?.listChanged
        : method === "notifications/resources/list_changed" ? caps?.resources?.listChanged
        : caps?.resources?.subscribe;
      if (!supported) return;
      if (method === "notifications/tools/list_changed") this.invalidateConnectionTools(connection.id);
      const pool = this.relayPools.get(connection.id)?.pool;
      if (pool?.has(client)) {
        // Every session announces the same app's changes, and requests that
        // share a session go to the first one, so only its notices count.
        if (pool.list()[0] !== client) return;
        // A shared session serves every thread granted the connection.
        for (const [token, grant] of this.grants) {
          if (grant.connectionId === connection.id) this.sendBridgeEvent(token, notification);
        }
        return;
      }
      for (const [token, session] of this.upstreamSessions) {
        if (session.client === client) this.sendBridgeEvent(token, notification);
      }
    };
    // Runs on a client that createUpstreamClient built, so the SDK has loaded.
    const {
      PromptListChangedNotificationSchema,
      ResourceListChangedNotificationSchema,
      ResourceUpdatedNotificationSchema,
      ToolListChangedNotificationSchema,
    } = loadedMcpTypes();
    client.setNotificationHandler(ToolListChangedNotificationSchema, forward);
    client.setNotificationHandler(PromptListChangedNotificationSchema, forward);
    client.setNotificationHandler(ResourceListChangedNotificationSchema, forward);
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, forward);
  }

  private async openUpstreamSession(
    token: string,
    connection: McpConnectionRecord,
    discovery: McpDiscovery,
  ): Promise<Client> {
    const generation = this.toolInventoryGenerations.get(connection.id) ?? 0;
    const session = await this.connectUpstreamClient(connection, {
      clientName: `pwragent-${connection.id}-proxy`,
      discovery,
      threadSession: true,
      handlers: {
        onElicit: async (client, request, signal) =>
          await this.routeUpstreamElicitation(token, client, request, signal),
        onElicitationComplete: (client, elicitationId) =>
          this.completeUpstreamUrlElicitation(token, client, elicitationId),
        ...(connection.kind === "stdio"
          ? { onListRoots: (client: Client) => this.listUpstreamRoots(token, client) }
          : {}),
      },
      // A session evicts itself when it actually dies. Leaving that to the
      // per-request error path would close a healthy session shared by every
      // in-flight request on this token the first time one of them was
      // cancelled or answered with an ordinary JSON-RPC error.
      onClose: (client) => {
        if (this.upstreamSessions.get(token)?.client === client) {
          this.upstreamSessions.delete(token);
          this.pwrSnapMediaLinks.forget(token);
          this.evictConnectionToolInventory(connection.id);
          if (runsLocalProcess(connection)) this.disconnectedStdioGrants.add(token);
          // The bridge closes its server on this event, and its agent cannot
          // reconnect it. A relay's next tool call starts a new session once
          // its app is back, so that bridge stays up to make the call.
          if (!isPwrSuiteRelayKind(connection.kind)) {
            this.sendBridgeEvent(token, { method: "connection/closed" });
          }
        }
      },
    });
    if (discovery.signal.aborted || !this.grants.has(token)
      || generation !== (this.toolInventoryGenerations.get(connection.id) ?? 0)
      || !this.gatewayEnabled()
      || !this.registry.get(connection.id)?.enabled) {
      await session.client.close();
      throw new Error("The MCP connection changed while its session was opening. Retry discovery.");
    }
    this.sessionIdentities.set(session.client, randomUUID());
    this.upstreamSessions.set(token, session);
    return session.client;
  }

  /**
   * Open an authorized MCP client for a connection.
   *
   * Shared by the per-thread proxy sessions and the Settings tool listing, so
   * both get the same credential check and the same PwrSnap credential rejection
   * handling rather than two copies that drift.
   */
  private async connectUpstreamClient(
    connection: McpConnectionRecord,
    options: {
      clientName: string;
      onClose?: (client: Client) => void;
      discovery: McpDiscovery;
      /** A thread's session, counted in a local command's running total. */
      threadSession?: boolean;
      handlers?: UpstreamSessionHandlers;
    },
  ): Promise<UpstreamSession> {
    let transport: Transport;
    if (connection.kind === "stdio") {
      return await this.connectStdioClient(connection, connection.stdio, options);
    }
    if (isPwrSuiteRelayKind(connection.kind)) {
      return await this.connectStdioClient(connection, this.relayLaunch(connection.kind), options);
    }
    // Build the client before the transport, so a failed SDK load cannot
    // leave an opened transport behind.
    const client = await this.createUpstreamClient(connection, options.clientName, options.handlers);
    if (isMcpIpcUrl(connection.serverUrl)) {
      const credential = await this.credentialVault.read(connection.id, connection.serverUrl);
      transport = await createMcpIpcTransport(connection.serverUrl, { bearerToken: credential?.ipcBearerToken });
    } else if (connection.kind === "sandboxer" && connection.authMode === "local_cli") {
      const status = await this.sandboxer.readStatus();
      if (!status.configured) throw new Error(status.detail);
      transport = await this.sandboxer.createTransport();
    } else {
      const coordinator = this.coordinatorFor(connection);
      if (!(await coordinator.configured())) {
        throw new Error(`${connection.displayName} needs to be reauthorized in Settings → Plugins.`);
      }
      const { StreamableHTTPClientTransport } = await mcpClientStreamableHttp.load();
      transport = new StreamableHTTPClientTransport(
        new URL(connection.serverUrl),
        { fetch: coordinator.authorizedFetch() },
      );
    }
    const onClose = options.onClose;
    if (onClose) client.onclose = () => onClose(client);
    const abort = (): void => { void transport.close().catch(() => undefined); };
    options.discovery.signal.addEventListener("abort", abort, { once: true });
    try {
      const observed = new McpInitializationTransport(transport);
      await client.connect(observed, {
        timeout: options.discovery.remaining(), signal: options.discovery.signal,
      });
      if (observed.initialization) this.initializations.set(client, observed.initialization);
      options.discovery.remaining();
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      options.discovery.signal.removeEventListener("abort", abort);
    }
    return { client, transport };
  }

  /**
   * Start a local command and complete the MCP handshake with it.
   *
   * Every failure path stops the process group before it returns, and the
   * reason -- with the server's stderr, secrets masked -- is kept for the
   * Settings row. The error thrown carries only PwrAgent's own description,
   * because it can reach an agent.
   */
  private async connectStdioClient(
    connection: McpConnectionRecord,
    launch: McpStdioLaunch | undefined,
    options: {
      clientName: string;
      onClose?: (client: Client) => void;
      discovery: McpDiscovery;
      threadSession?: boolean;
      handlers?: UpstreamSessionHandlers;
    },
  ): Promise<UpstreamSession> {
    if (!launch) throw new Error(`${connection.displayName} has no command to run.`);
    let transport: OwnedStdioClientTransport | undefined;
    const client = await this.createUpstreamClient(connection, options.clientName, options.handlers);
    const abort = (): void => { void transport?.close().catch(() => undefined); };
    options.discovery.signal.addEventListener("abort", abort, { once: true });
    try {
      const secretNames = launch.env.filter((entry) => entry.secret);
      let secretValues: Record<string, string> = {};
      if (secretNames.length > 0) {
        try {
          secretValues = await this.stdioSecrets.read(connection.id);
        } catch {
          throw new McpStdioLaunchError(
            "secret_unavailable",
            `PwrAgent could not read ${connection.displayName}'s stored secrets. Edit it in Settings → Plugins and enter them again.`,
          );
        }
      }
      options.discovery.remaining();
      // Only a thread's copy counts toward "Running": a Settings listing
      // starts one for a moment and stops it.
      transport = await this.createStdioTransport(
        options.threadSession ? connection.id : "",
        launch,
        secretValues,
      );
      const onClose = options.onClose;
      if (onClose) client.onclose = () => onClose(client);
      const observed = new McpInitializationTransport(transport);
      await client.connect(observed, {
        timeout: options.discovery.remaining(), signal: options.discovery.signal,
      });
      if (observed.initialization) this.initializations.set(client, observed.initialization);
      options.discovery.remaining();
      return { client, transport };
    } catch (error) {
      client.onclose = undefined;
      await transport?.close().catch(() => undefined);
      if (options.discovery.signal.aborted && options.discovery.signal.reason?.name !== "TimeoutError") {
        throw error;
      }
      const failure = describeStdioStartFailure({
        error,
        transport,
        displayName: connection.displayName,
        command: launch.command,
        timedOut: options.discovery.signal.aborted
          || (isMcpError(error) && error.code === loadedMcpTypes().ErrorCode.RequestTimeout),
      });
      this.discoveryHealth.set(connection.id, {
        ...this.discoveryHealth.get(connection.id),
        state: "failed",
        lastFailure: {
          at: Date.now(),
          message: failure.message,
          ...(failure.output ? { output: failure.output } : {}),
        },
      });
      throw failure;
    } finally {
      options.discovery.signal.removeEventListener("abort", abort);
    }
  }

  /**
   * An MCP client for one upstream connection.
   *
   * Only a thread session declares elicitation; its forms and links are
   * routed per request. Only a local command's thread session declares
   * roots. Settings reads and tests declare nothing, as before, so a server
   * never asks them for a person's answer or a directory.
   */
  private async createUpstreamClient(
    connection: McpConnectionRecord,
    clientName: string,
    handlers: UpstreamSessionHandlers = {},
  ): Promise<Client> {
    const [{ Client }, { ElicitationCompleteNotificationSchema, ListRootsRequestSchema }, VerbatimElicitRequestSchema] = await Promise.all([
      mcpClient.load(), mcpTypes.load(), verbatimElicitRequestSchema.load(),
    ]);
    const capabilities: ClientCapabilities = {
      ...(handlers.onElicit ? UPSTREAM_THREAD_ELICITATION_CAPABILITIES : {}),
      ...(handlers.onListRoots ? { roots: { listChanged: true } } : {}),
    };
    const client = new Client({ name: clientName, version: "1.0.0" }, { capabilities });
    this.installDiscoveryNotifications(client, connection);
    const { onElicit, onListRoots, onElicitationComplete } = handlers;
    if (onElicit) {
      client.setRequestHandler(VerbatimElicitRequestSchema, async (request, extra) =>
        await onElicit(client, request.params as ElicitRequestParams, extra.signal));
    }
    if (onListRoots) {
      client.setRequestHandler(ListRootsRequestSchema, () => onListRoots(client));
    }
    if (onElicitationComplete) {
      client.setNotificationHandler(ElicitationCompleteNotificationSchema, (notification) => {
        onElicitationComplete(client, notification.params.elicitationId);
      });
    }
    return client;
  }

  /**
   * Send an upstream server's form to the request on this session that
   * caused it, and its answer back, or fail closed.
   *
   * The person is asked only while the grant, this exact session and (for the
   * gateway's fixed tools) the thread's selection are all still current, and
   * the answer is delivered only if they still are. Otherwise the server
   * hears `cancel`. A host execution grant, Full Access or tool-approval
   * policy never answers a form: only the caller's client does.
   */
  private async routeUpstreamElicitation(
    token: string,
    client: Client,
    request: ElicitRequestParams,
    signal: AbortSignal,
  ): Promise<ElicitResult> {
    const grant = this.grants.get(token);
    if (!grant) throw elicitationUnavailable("This MCP session is no longer granted to a thread.");
    const gatewayScoped = grant.threadId?.startsWith("[\"gateway\"") === true;
    const stillCurrent = async (): Promise<void> => {
      if (this.grants.get(token) !== grant || !this.isCurrentUpstream(token, client)) {
        throw new Error("This MCP session has been replaced.");
      }
      this.requireAvailableConnection(grant.connectionId);
      if (gatewayScoped) await this.requireGatewaySelection(grant);
    };
    return await this.elicitationRoutes.route({
      token,
      client,
      request,
      // A local command may send its own page on this machine; nothing else may.
      source: { local: this.registry.get(grant.connectionId)?.kind === "stdio" },
      signal,
      beforeAsk: stillCurrent,
      beforeAnswer: stillCurrent,
      // Never the form's text or the answer: either can carry private data.
      onOutcome: (outcome) => connectionLog.info("upstream MCP form", {
        connectionId: grant.connectionId,
        outcome,
      }),
    });
  }

  /**
   * Show the sign-in links a tool call's `-32042` error names, one at a
   * time, to the person whose call it was, then hand the call's error back
   * with what happened. The call is never retried here: the server may have
   * done part of a write before it asked, and only the agent can decide to
   * call again once the person has signed in.
   */
  private async offerRequiredUrlElicitations(
    token: string,
    client: Client,
    error: McpError,
    signal: AbortSignal | undefined,
  ): Promise<McpError> {
    const listed = (error.data as { elicitations?: unknown } | undefined)?.elicitations;
    const requests = Array.isArray(listed) ? listed.slice(0, MAX_REQUIRED_URL_ELICITATIONS) : [];
    const actions: string[] = [];
    for (const entry of requests) {
      if (signal?.aborted) break;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const request = { ...(entry as Record<string, unknown>), mode: "url" } as ElicitRequestParams;
      try {
        const result = await this.routeUpstreamElicitation(token, client, request, signal ?? new AbortController().signal);
        actions.push(result.action);
      } catch {
        actions.push("refused");
      }
    }
    const reason = error.message.replace(/^MCP error -?\d+: /, "");
    const note = actions.includes("accept")
      ? " PwrAgent showed the operator the sign-in page and they opened it. Call the tool again after they confirm sign-in is finished; check first whether the earlier call already changed anything."
      : actions.length > 0
        ? " PwrAgent showed the operator the sign-in page, but they did not open it."
        : "";
    const { McpError } = await mcpTypes.load();
    return new McpError(error.code, `${reason}${note}`, error.data);
  }

  /** A link a native host's person opened, kept until the server says it is done. */
  private rememberOpenedUrlElicitation(token: string, client: Client, elicitationId: string): void {
    let opened = this.openedUrlElicitations.get(client);
    if (!opened) {
      opened = new Map();
      this.openedUrlElicitations.set(client, opened);
    }
    opened.delete(elicitationId);
    opened.set(elicitationId, token);
    while (opened.size > MAX_OPENED_URL_ELICITATIONS) {
      opened.delete(opened.keys().next().value!);
    }
  }

  /**
   * The server finished a link's flow. Only the native host that opened that
   * link is told, and only while the session it came from is still current.
   * Any other id is ignored, as the spec requires.
   */
  private completeUpstreamUrlElicitation(token: string, client: Client, elicitationId: string): void {
    const opened = this.openedUrlElicitations.get(client);
    if (opened?.get(elicitationId) !== token) return;
    opened.delete(elicitationId);
    if (!this.isCurrentUpstream(token, client)) return;
    this.sendBridgeEvent(token, {
      method: "notifications/elicitation/complete",
      params: { elicitationId },
    });
  }

  /**
   * How the thread's instance reads a thread's directories. The backend
   * registry sets this; without it no roots are reported.
   */
  setThreadRootsResolver(resolver: (scope: ThreadRootsScope) => Promise<ThreadRootDirectory[]>): void {
    this.threadRootsResolver = resolver;
  }

  /**
   * A thread's directories changed in this instance. Threads whose grants
   * were registered here report their roots again; the owner then tells each
   * session whose roots changed.
   */
  noteThreadDirectoriesChanged(backend: AppServerBackendKind, threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      const key = buildThreadIdentityKey(backend, threadId);
      if (this.rootThreads.has(key)) this.refreshThreadRoots(key, { backend, threadId });
    }
  }

  /**
   * Report a registered thread's roots to the owner. A registration repeats
   * on every turn and gateway call, so a recent report is not repeated.
   */
  private noteRootThread(scopeKey: string | undefined, backend: AppServerBackendKind | undefined): void {
    const scope = threadRootsScope(scopeKey, backend);
    if (!scope || !this.threadRootsResolver) return;
    const key = buildThreadIdentityKey(scope.backend, scope.threadId);
    const known = this.rootThreads.get(key);
    if (known && Date.now() - known.refreshedAt < ROOTS_REFRESH_INTERVAL_MS) return;
    this.refreshThreadRoots(key, scope);
  }

  private refreshThreadRoots(key: string, scope: ThreadRootsScope): void {
    const resolver = this.threadRootsResolver;
    if (!resolver || !this.gatewayEnabled()) return;
    const generation = (this.rootThreads.get(key)?.generation ?? 0) + 1;
    this.rootThreads.delete(key);
    this.rootThreads.set(key, { scope, refreshedAt: Date.now(), generation });
    while (this.rootThreads.size > MAX_ROOT_THREADS) {
      this.rootThreads.delete(this.rootThreads.keys().next().value!);
    }
    // Reports for one thread run one after another, so an older list never
    // reaches the owner after a newer one. A superseded report sends nothing.
    const superseded = (): boolean => this.rootThreads.get(key)?.generation !== generation;
    const report = (this.rootReports.get(key) ?? Promise.resolve()).then(async () => {
      if (superseded()) return;
      const roots = buildUpstreamRoots(await resolver(scope));
      if (superseded()) return;
      const ownership = await this.ensureOwnerBroker();
      if (ownership.owned) {
        this.storeThreadRoots(key, roots);
        return;
      }
      await this.requestOwnerBroker<boolean>(ownership.holder, "broker/thread-roots", {
        backend: scope.backend,
        threadId: scope.threadId,
        roots,
      });
    }).catch((error: unknown) => {
      connectionLog.warn("MCP roots update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (this.rootReports.get(key) === report) this.rootReports.delete(key);
    });
    this.rootReports.set(key, report);
  }

  /** The owner's copy of a thread's roots; every session of it hears a change. */
  private storeThreadRoots(key: string, roots: Root[]): void {
    this.threadRoots.delete(key);
    this.threadRoots.set(key, roots);
    if (this.threadRoots.size > MAX_ROOT_THREADS) {
      // Only a thread no grant serves is dropped: an empty answer to a live
      // session would leave a server working outside the thread.
      const live = new Set([...this.grants.values()].map(grantRootsKey));
      for (const stale of [...this.threadRoots.keys()]) {
        if (this.threadRoots.size <= MAX_ROOT_THREADS) break;
        if (!live.has(stale)) this.threadRoots.delete(stale);
      }
    }
    for (const [token, grant] of this.grants) {
      if (grantRootsKey(grant) === key) this.announceGrantRoots(token, grant);
    }
  }

  /**
   * Send `notifications/roots/list_changed` to a grant's session when its
   * roots differ from what it last read. A session that never asked is not
   * told: it reads the current list when it first asks.
   */
  private announceGrantRoots(token: string, grant: BridgeGrant): void {
    const client = this.upstreamSessions.get(token)?.client;
    const known = client ? this.rootsKnown.get(client) : undefined;
    if (!client || known === undefined) return;
    const key = grantRootsKey(grant);
    const fingerprint = rootsFingerprint((key && this.threadRoots.get(key)) || []);
    if (known === fingerprint) return;
    this.rootsKnown.set(client, fingerprint);
    void client.sendRootsListChanged().catch((error: unknown) => {
      connectionLog.warn("MCP roots change notification failed", {
        connectionId: grant.connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * A local command's `roots/list`: the directories of the thread its grant
   * serves, or none before the grant names a thread. A replaced or revoked
   * session is refused. A session still opening is answered: a server may
   * ask before PwrAgent has finished recording it.
   */
  private listUpstreamRoots(token: string, client: Client): { roots: Root[] } {
    const grant = this.grants.get(token);
    const current = this.upstreamSessions.get(token)?.client;
    if (!grant || (current && current !== client)) {
      // Answers the server's own request, so its SDK session has loaded.
      const { ErrorCode, McpError } = loadedMcpTypes();
      throw new McpError(ErrorCode.InvalidRequest, "This MCP session is no longer granted to a thread.");
    }
    const key = grantRootsKey(grant);
    const roots = (key && this.threadRoots.get(key)) || [];
    this.rootsKnown.set(client, rootsFingerprint(roots));
    return { roots: roots.map((root) => ({ ...root })) };
  }

  /**
   * Stop the sessions a thread holds for the given connections.
   *
   * Called when a thread turns connections off. The thread's grant survives,
   * as it does for every connection, because its agent learns of the change
   * only on its next turn or session load; what ends now is the local
   * process the thread no longer selects.
   */
  async closeThreadSessions(threadId: string, connectionIds: readonly string[]): Promise<void> {
    if (connectionIds.length === 0) return;
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      await this.requestOwnerBroker<boolean>(
        ownership.holder,
        "broker/close-thread-sessions",
        { threadId, connectionIds },
      );
      return;
    }
    const targets = new Set(connectionIds);
    await Promise.all(
      [...this.grants.entries()]
        .filter(([, grant]) => targets.has(grant.connectionId) && grantThreadId(grant) === threadId)
        .map(async ([token]) => await this.closeUpstreamSession(token)),
    );
  }

  /** A read of the broker's sessions only: no probing, process start or consent. */
  async readThreadSessionStates(
    threadId: string,
    backend: AppServerBackendKind,
  ): Promise<Record<string, McpThreadSessionStates>> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker(ownership.holder, "broker/thread-session-states", { threadId, backend });
    }
    const state = (token: string | undefined): McpThreadSessionState => {
      if (!token) return "not_started";
      const pool = this.relayPools.get(this.grants.get(token)?.connectionId ?? "")?.pool;
      if (pool) {
        // Shared sessions: the thread's state is the pool's.
        if (pool.size > 0) return "ready";
        if (pool.isOpening) return "connecting";
        return pool.ended ? "ended" : "not_started";
      }
      if (this.disconnectedStdioGrants.has(token)) return "ended";
      if (this.upstreamSessions.has(token)) return "ready";
      if (this.upstreamStarts.has(token)) return "connecting";
      return "not_started";
    };
    const result: Record<string, McpThreadSessionStates> = {};
    for (const connection of this.registry.list()) {
      const native = this.threadRegistrations.get(`${connection.id}:${threadId}`)?.token;
      const gateway = this.threadRegistrations.get(`${connection.id}:${JSON.stringify(["gateway", backend, threadId])}`)?.token;
      result[connection.id] = { native: state(native), gateway: state(gateway) };
    }
    return result;
  }

  /**
   * Explicit operator recovery for an arbitrary local command. Retire every
   * grant before awaiting shutdown so old requests/approvals cannot cross the
   * boundary. The next discovery opens a new session; this starts no process,
   * launches no desktop app, and never retries an operation.
   */
  async reconnectThreadConnection(connectionId: string, threadId: string, backend: AppServerBackendKind): Promise<void> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      await this.requestOwnerBroker(ownership.holder, "broker/reconnect-thread", { connectionId, threadId, backend });
      return;
    }
    const connection = this.requireAvailableConnection(connectionId);
    if (connection.kind !== "stdio") throw new Error("Only a local command can be reconnected here.");
    this.threadConsentEpochs.set(JSON.stringify([connectionId, backend, threadId]), randomUUID());
    const tokens: string[] = [];
    for (const [token, grant] of this.grants) {
      if (grant.connectionId !== connectionId) continue;
      let matches = grant.threadId === threadId && (!grant.backend || grant.backend === backend);
      if (grant.threadId?.startsWith("[\"gateway\"")) {
        const scope = this.gatewaySelectionScope(grant);
        const owner = scope.delegation?.selectionOwner ?? scope;
        matches = owner.threadId === threadId && owner.backend === backend;
      }
      if (!matches) continue;
      this.grants.delete(token);
      this.relayGrantEpochs.delete(token);
      this.sendBridgeEvent(token, { method: "connection/closed" });
      tokens.push(token);
    }
    for (const [key, registration] of this.threadRegistrations) {
      if (tokens.includes(registration.token)) this.threadRegistrations.delete(key);
    }
    await Promise.all(tokens.map(async (token) => await this.closeUpstreamSession(token)));
    this.announceChanged([connectionId]);
  }

  /**
   * The bytes of a `pwrsnap://` image link in a thread's transcript.
   *
   * Read only through the live PwrSnap session that returned the link to
   * that thread (see `PwrSnapMediaLinks`). Nothing here opens a session: a
   * link with no live session behind it is `session-ended`, and the
   * transcript shows it as unavailable instead of retrying.
   */
  async readPwrSnapMediaResource(request: {
    backend?: AppServerBackendKind;
    threadId: string;
    uri: string;
  }): Promise<PwrSnapMediaRead> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<PwrSnapMediaRead>(
        ownership.holder,
        "broker/read-pwrsnap-media",
        request,
        MAX_PWRSNAP_MEDIA_RESPONSE_BYTES,
      );
    }
    const owner = this.pwrSnapMediaLinks.resolve(request.threadId, request.uri, {
      isLive: (candidate, session) => this.isCurrentUpstream(candidate, session as Client),
      threadOf: (candidate) => {
        const grant = this.grants.get(candidate);
        if (!grant) return undefined;
        // Thread ids are unique per backend only.
        if (request.backend && grant.backend && grant.backend !== request.backend) return undefined;
        return grantThreadId(grant);
      },
    });
    const client = owner?.session as Client | undefined;
    if (!client) return { ok: false, reason: "session-ended" };
    let pending = this.pendingPwrSnapMediaReads.get(client);
    const existing = pending?.get(request.uri);
    if (existing) return await existing;
    if (!pending) {
      pending = new Map();
      this.pendingPwrSnapMediaReads.set(client, pending);
    }
    const read = this.readPwrSnapMediaFromSession(client, request.uri);
    pending.set(request.uri, read);
    try {
      return await read;
    } finally {
      pending.delete(request.uri);
    }
  }

  private async readPwrSnapMediaFromSession(client: Client, uri: string): Promise<PwrSnapMediaRead> {
    let failed = this.failedPwrSnapMediaReads.get(client);
    if (failed?.has(uri)) return { ok: false, reason: "failed" };
    let read: PwrSnapMediaRead;
    try {
      const result = await client.readResource(
        { uri },
        { timeout: PWRSNAP_MEDIA_READ_TIMEOUT_MS },
      );
      read = readPwrSnapImageContents(result, uri);
    } catch (error) {
      connectionLog.warn("PwrSnap media read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      read = { ok: false, reason: "failed" };
    }
    if (!read.ok) {
      if (!failed) {
        failed = new Set();
        this.failedPwrSnapMediaReads.set(client, failed);
      }
      failed.add(uri);
    }
    return read;
  }

  /**
   * `connectionId` names the grant's connection when a revoke has already
   * deleted the grant.
   */
  private async closeUpstreamSession(
    token: string,
    resetDisconnected = true,
    connectionId = this.grants.get(token)?.connectionId,
  ): Promise<void> {
    if (resetDisconnected) this.disconnectedStdioGrants.delete(token);
    if (connectionId !== undefined && this.relayPools.has(connectionId)) {
      // This grant's use of the shared sessions ends. They stay open while
      // another grant still uses them, and close with the last one.
      if (this.grants.has(token)) this.relayGrantEpochs.set(token, randomUUID());
      if (!this.relayHasOtherUser(connectionId, token)) await this.closeRelayPool(connectionId);
    }
    const start = this.upstreamStarts.get(token);
    this.upstreamStarts.delete(token);
    start?.controller.abort(new DOMException("MCP session closed.", "AbortError"));
    const session = this.upstreamSessions.get(token);
    this.upstreamSessions.delete(token);
    this.pwrSnapMediaLinks.forget(token);
    if (!session) return;
    this.sendBridgeEvent(token, { method: "connection/closed" });
    await session.client.close().catch(async () => {
      await session.transport.close().catch(() => undefined);
    });
  }

  /**
   * Drop every live upstream session.
   *
   * Called when the profile-wide gateway switch goes off. `registerBridge`
   * and `ensureUpstreamClient` already refuse new work, but a session that
   * was opened while the switch was on holds an authorized transport and a
   * remote session id, and no reconnection is needed to keep using them.
   * Turning the gateway off has to end those too, not only forbid new ones.
   */
  async closeAllUpstreamSessions(): Promise<void> {
    for (const connectionId of new Set([...this.grants.values()].map((grant) => grant.connectionId))) {
      this.invalidateConnectionTools(connectionId);
    }
    await Promise.all([
      ...[...new Set([...this.upstreamSessions.keys(), ...this.upstreamStarts.keys()])].map(
        async (token) => await this.closeUpstreamSession(token),
      ),
      ...[...this.relayPools.keys()].map(async (connectionId) => await this.closeRelayPool(connectionId)),
    ]);
  }

  private async closeConnectionSessions(connectionId: string): Promise<void> {
    // Invalidate before awaiting close, including sessions still opening.
    this.invalidateConnectionTools(connectionId);
    await Promise.all([
      ...[...this.grants.entries()]
        .filter(([, grant]) => grant.connectionId === connectionId)
        .map(async ([token]) => await this.closeUpstreamSession(token)),
      this.closeRelayPool(connectionId),
    ]);
  }

  private async startBridgeServer(): Promise<void> {
    if (this.bridgeServer) return;
    if (this.bridgeStart) return await this.bridgeStart;
    this.bridgeStart = this.startBridgeServerNow().finally(() => {
      this.bridgeStart = undefined;
    });
    await this.bridgeStart;
  }

  private async startBridgeServerNow(): Promise<void> {
    let socketPath: string;
    if (process.platform === "win32") {
      socketPath = `\\\\.\\pipe\\pwragent-mcp-${randomBytes(8).toString("hex")}`;
    } else {
      const directory = await mkdtemp(join(tmpdir(), "pwa-mcp-"));
      await chmod(directory, 0o700).catch(() => undefined);
      this.bridgeSocketDirectory = directory;
      socketPath = join(directory, "bridge.sock");
    }
    const server = createServer((socket) => this.handleBridgeSocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      await chmod(socketPath, 0o600).catch(() => undefined);
    }
    this.bridgeServer = server;
    this.bridgeSocketPath = socketPath;
    if (this.leaseHeld && this.leaseManager && this.brokerToken) {
      try {
        this.brokerDiscovery.publish({
          version: 1,
          ownerInstanceId: this.leaseManager.id,
          socketPath,
          brokerToken: this.brokerToken,
          publishedAt: Date.now(),
        });
      } catch (error) {
        this.bridgeServer = undefined;
        this.bridgeSocketPath = undefined;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const directory = this.bridgeSocketDirectory;
        this.bridgeSocketDirectory = undefined;
        if (directory) {
          await rm(directory, { recursive: true, force: true })
            .catch(() => undefined);
        }
        throw error;
      }
    }
    connectionLog.info("MCP connection bridge listening", { socketPath });
  }

  private handleBridgeSocket(socket: Socket): void {
    // In-flight RPCs keep their old bound of 32 sockets. A socket that turns
    // out to be an attach leaves this count when it is classified.
    if (this.activeRpcSockets >= MAX_RPC_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.activeRpcSockets += 1;
    this.rpcSockets.add(socket);
    socket.once("close", () => {
      if (this.rpcSockets.delete(socket)) this.activeRpcSockets -= 1;
    });
    socket.setEncoding("utf8");
    socket.setTimeout(MCP_CONNECTION_TOOL_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    // One request per socket. Lines after it are answers to the upstream
    // server's forms, and only a request that opted in listens for them.
    let followUp: ((line: string) => void) | undefined;
    const ignoreLine: (line: string) => void = () => undefined;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RPC_LINE_BYTES) {
        this.respond(socket, { ok: false, error: "request too large" });
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (followUp) {
          followUp(line);
          continue;
        }
        followUp = ignoreLine;
        void this.handleBridgeLine(socket, line, (handler) => { followUp = handler; });
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private async handleBridgeLine(
    socket: Socket,
    line: string,
    listen: (handler: (line: string) => void) => void,
  ): Promise<void> {
    let request: BridgeRequest;
    try {
      request = JSON.parse(line) as BridgeRequest;
    } catch {
      this.respond(socket, { ok: false, error: "malformed request" });
      return;
    }
    if (typeof request.brokerToken === "string") {
      if (!secureTokenEqual(request.brokerToken, this.brokerToken)) {
        this.respond(socket, { ok: false, error: "unauthorized" });
        return;
      }
      try {
        const result = await this.dispatchBrokerOperation(
          request.op,
          request.params,
        );
        this.respond(socket, { ok: true, result });
      } catch (error) {
        this.respond(socket, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (typeof request.token !== "string") {
      this.respond(socket, { ok: false, error: "unauthorized" });
      return;
    }
    const grant = this.grants.get(request.token);
    if (!grant) {
      this.respond(socket, { ok: false, error: "unauthorized" });
      return;
    }
    if (request.op === "attach") {
      this.attachBridge(request.token, grant, socket);
      return;
    }
    const abortController = new AbortController();
    socket.once("close", () => abortController.abort());
    // Set up before the first await, so an answer cannot arrive unheard.
    const forms = request.elicitation === ELICITATION_WIRE_OPT_IN
      ? new ElicitationWireChannel((wireLine) => {
        if (socket.destroyed || socket.writableEnded) return false;
        socket.write(`${JSON.stringify(wireLine)}\n`);
        return true;
      })
      : undefined;
    if (forms) {
      listen((answer) => forms.receive(answer));
      socket.once("close", () => forms.close());
    }
    const onProgress = request.progress === PROGRESS_WIRE_OPT_IN
      ? (report: Progress): void => {
        const progress = bridgeProgress(report);
        if (!progress || socket.destroyed || socket.writableEnded) return;
        socket.write(`${JSON.stringify({ progress })}\n`);
      }
      : undefined;
    try {
      const result = await this.dispatchBridgeOperation(
        request.token,
        grant,
        request.op,
        request.params,
        abortController.signal,
        typeof request.deadlineAt === "number" && Number.isFinite(request.deadlineAt) ? request.deadlineAt : undefined,
        typeof request.discoveryId === "string" && /^[a-f0-9-]{36}$/.test(request.discoveryId) ? request.discoveryId : undefined,
        forms?.route,
        onProgress,
        Boolean(forms) && request.urlElicitation === URL_ELICITATION_WIRE_OPT_IN,
      );
      forms?.close();
      this.respond(socket, { ok: true, result });
    } catch (error) {
      forms?.close();
      // Deliberately no session teardown here. One token is shared by every
      // in-flight request from the bridge child, so closing on any failure
      // would take a cancelled call, a 429, or a `-32602` and turn it into
      // `Connection closed` for each of its siblings. A session that really
      // is gone removes itself through `client.onclose`.
      const message = error instanceof Error ? error.message : String(error);
      connectionLog.warn("proxied MCP operation failed", {
        connectionId: grant.connectionId,
        errorName: error instanceof Error ? error.name : "Error",
        operation: request.op,
        ...(isMcpDiscoveryError(error) ? { diagnostic: error.data } : {}),
      });
      this.respond(socket, {
        ok: false,
        error: message,
        ...(isMcpError(error) ? { code: error.code, data: error.data } : {}),
      });
    }
  }

  /**
   * Hold a bridge child's attach socket open for its lifetime.
   *
   * When the last socket for a grant closes, the agent that started the
   * bridge has exited or dropped its MCP servers. A local command started
   * for that grant is stopped then, rather than running until PwrAgent quits.
   * The grant itself survives: the agent may start the bridge again for the
   * same thread, and the next request starts a fresh process.
   */
  private attachBridge(token: string, grant: BridgeGrant, socket: Socket): void {
    if (this.rpcSockets.delete(socket)) this.activeRpcSockets -= 1;
    if (this.bridgeAttachmentCount >= MAX_BRIDGE_ATTACHMENTS) {
      this.respond(socket, { ok: false, error: "too many attached bridges" });
      return;
    }
    socket.setTimeout(0);
    let sockets = this.bridgeAttachments.get(token);
    if (!sockets) {
      sockets = new Set();
      this.bridgeAttachments.set(token, sockets);
    }
    sockets.add(socket);
    this.bridgeAttachmentCount += 1;
    const detach = (): void => {
      const current = this.bridgeAttachments.get(token);
      if (!current?.delete(socket)) return;
      this.bridgeAttachmentCount -= 1;
      if (current.size > 0) return;
      this.bridgeAttachments.delete(token);
      const connection = this.registry.get(grant.connectionId);
      if (connection && runsLocalProcess(connection)) {
        void this.closeUpstreamSession(token, false);
      }
    };
    socket.once("close", detach);
    if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: true, result: true })}\n`);
  }

  private async dispatchBrokerOperation(
    operation: unknown,
    params: unknown,
  ): Promise<unknown> {
    const values = params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
    if (operation === "broker/list") {
      return await this.listConnections({
        cachedLocalStatus: values.cachedLocalStatus === true,
        ...(typeof values.sandboxerStatusMaxAgeMs === "number"
          && Number.isFinite(values.sandboxerStatusMaxAgeMs)
          ? { sandboxerStatusMaxAgeMs: values.sandboxerStatusMaxAgeMs }
          : {}),
      });
    }
    if (operation === "broker/pwrsnap-status") {
      return await this.readStatus();
    }
    if (operation === "broker/pwrsnap-connect") {
      return await this.connect();
    }
    if (operation === "broker/create") {
      if (
        typeof values.displayName !== "string"
        || (typeof values.serverUrl !== "string" && values.stdio === undefined)
      ) {
        throw new Error("Invalid MCP connection create request.");
      }
      return await this.createConnection({
        displayName: values.displayName,
        ...(typeof values.serverUrl === "string" ? { serverUrl: values.serverUrl } : {}),
        ...(values.ipcBearerToken !== undefined ? { ipcBearerToken: values.ipcBearerToken as string } : {}),
        // Validated field by field in prepareStdioLaunch.
        ...(values.stdio !== undefined ? { stdio: values.stdio as McpStdioLaunchInput } : {}),
      });
    }
    if (operation === "broker/test-stdio") {
      return await this.testStdioConnection({
        stdio: values.stdio as McpStdioLaunchInput,
        ...(typeof values.connectionId === "string" ? { connectionId: values.connectionId } : {}),
      });
    }
    if (operation === "broker/thread-session-states" || operation === "broker/reconnect-thread") {
      if (typeof values.threadId !== "string" || !values.threadId || typeof values.backend !== "string"
        || !(values.backend === "codex" || values.backend === "claude" || isAcpBackendId(values.backend))) {
        throw new Error("Invalid MCP thread session request.");
      }
      if (operation === "broker/thread-session-states") return await this.readThreadSessionStates(values.threadId, values.backend as AppServerBackendKind);
      if (typeof values.connectionId !== "string") throw new Error("Invalid MCP reconnect request.");
      await this.reconnectThreadConnection(values.connectionId, values.threadId, values.backend as AppServerBackendKind);
      return true;
    }
    if (operation === "broker/thread-roots") {
      if (typeof values.backend !== "string" || !values.backend
        || typeof values.threadId !== "string" || !values.threadId) {
        throw new Error("Invalid MCP roots update.");
      }
      this.storeThreadRoots(
        buildThreadIdentityKey(values.backend as AppServerBackendKind, values.threadId),
        readRelayedRoots(values.roots),
      );
      return true;
    }
    if (operation === "broker/read-pwrsnap-media") {
      if (typeof values.threadId !== "string" || typeof values.uri !== "string") {
        throw new Error("Invalid PwrSnap media read request.");
      }
      return await this.readPwrSnapMediaResource({
        ...(typeof values.backend === "string" ? { backend: values.backend as AppServerBackendKind } : {}),
        threadId: values.threadId,
        uri: values.uri,
      });
    }
    if (operation === "broker/close-thread-sessions") {
      if (
        typeof values.threadId !== "string"
        || !Array.isArray(values.connectionIds)
        || values.connectionIds.some((id) => typeof id !== "string")
      ) {
        throw new Error("Invalid MCP thread session release request.");
      }
      await this.closeThreadSessions(values.threadId, values.connectionIds as string[]);
      return true;
    }
    if (operation === "broker/update") {
      if (typeof values.connectionId !== "string") {
        throw new Error("Invalid MCP connection update request.");
      }
      return await this.updateConnection({
        connectionId: values.connectionId,
        ...(typeof values.displayName === "string"
          ? { displayName: values.displayName }
          : {}),
        ...(typeof values.serverUrl === "string"
          ? { serverUrl: values.serverUrl }
          : {}),
        ...(values.ipcBearerToken !== undefined ? { ipcBearerToken: values.ipcBearerToken as string } : {}),
        ...(values.stdio !== undefined ? { stdio: values.stdio as McpStdioLaunchInput } : {}),
      });
    }
    if (operation === "broker/probe") {
      if (typeof values.serverUrl !== "string") {
        throw new Error("Invalid MCP connection probe request.");
      }
      return await this.probeConnection({ serverUrl: values.serverUrl });
    }
    if (operation === "broker/set-select-for-new-threads") {
      if (
        typeof values.connectionId !== "string"
        || typeof values.selectForNewThreads !== "boolean"
      ) {
        throw new Error("Invalid MCP connection new-thread default request.");
      }
      return await this.setConnectionSelectForNewThreads(
        values.connectionId,
        values.selectForNewThreads,
      );
    }
    if (operation === "broker/set-sandboxer-transport") {
      if (!isSandboxerTransport(values.transport)) throw new Error("Choose a Sandboxer transport.");
      return await this.setSandboxerTransport(values.transport);
    }
    if (operation === "broker/set-sandboxer-cleanup-on-pr-close") {
      if (typeof values.enabled !== "boolean") {
        throw new Error("Invalid Sandboxer cleanup on PR close request.");
      }
      return await this.setSandboxerCleanupOnPrClose(values.enabled);
    }
    if (operation === "broker/set-linear-paste-images") {
      if (typeof values.enabled !== "boolean") {
        throw new Error("Invalid Linear paste images request.");
      }
      await this.setLinearPasteImages(values.enabled);
      return null;
    }
    if (operation === "broker/set-tool-approval") {
      if (
        typeof values.connectionId !== "string"
        || !isMcpConnectionToolApproval(values.toolApproval)
      ) {
        throw new Error("Invalid MCP connection tool approval request.");
      }
      return await this.setConnectionToolApproval(
        values.connectionId,
        values.toolApproval,
      );
    }
    if (operation === "broker/set-project-tool-approval") {
      if (
        typeof values.connectionId !== "string"
        || typeof values.repository !== "string"
        || (values.toolApproval !== null && !isMcpConnectionToolApproval(values.toolApproval))
      ) {
        throw new Error("Invalid MCP connection project tool approval request.");
      }
      return await this.setConnectionProjectToolApproval(
        values.connectionId,
        values.repository,
        values.toolApproval,
      );
    }
    if (operation === "broker/list-tools") {
      if (typeof values.connectionId !== "string") {
        throw new Error("Invalid MCP connection tool list request.");
      }
      return await this.listConnectionTools({
        connectionId: values.connectionId,
        ...(values.refresh === true ? { refresh: true } : {}),
      });
    }
    if (operation === "broker/set-enabled") {
      if (
        typeof values.connectionId !== "string"
        || typeof values.enabled !== "boolean"
      ) {
        throw new Error("Invalid MCP connection availability request.");
      }
      return await this.setConnectionEnabled(
        values.connectionId,
        values.enabled,
      );
    }
    if (
      operation === "broker/authorize"
      || operation === "broker/cancel-authorize"
      || operation === "broker/disconnect"
      || operation === "broker/remove"
    ) {
      if (typeof values.connectionId !== "string") {
        throw new Error("Invalid MCP connection request.");
      }
      if (operation === "broker/authorize") {
        return await this.authorizeConnection(values.connectionId);
      }
      // The attempt being abandoned lives in the owner broker's process, which
      // is where this already runs -- the same place the callback listener it
      // has to close was opened.
      if (operation === "broker/cancel-authorize") {
        return await this.cancelAuthorization(values.connectionId);
      }
      if (operation === "broker/disconnect") {
        return await this.disconnectConnection(values.connectionId);
      }
      return await this.removeConnection(values.connectionId);
    }
    if (operation === "broker/register") {
      if (typeof values.connectionId !== "string") {
        throw new Error("Invalid MCP bridge registration request.");
      }
      const connection = this.requireAvailableConnection(values.connectionId);
      const status = await this.connectionStatus(connection);
      if (!status.configured) {
        throw new Error(
          connection.authMode === "local_cli" || connection.kind === "stdio" ? status.detail
            : `${connection.displayName} is not connected to PwrAgent. Reauthorize it in Settings → Plugins.`,
        );
      }
      const threadId = typeof values.threadId === "string"
        ? values.threadId
        : undefined;
      const registrationKey = threadId
        ? `${connection.id}:${threadId}`
        : undefined;
      const existing = registrationKey
        ? this.threadRegistrations.get(registrationKey)
        : undefined;
      const backend = typeof values.backend === "string" && values.backend
        ? values.backend as AppServerBackendKind
        : undefined;
      if (existing && this.grants.has(existing.token)) {
        this.adoptGrantBackend(existing.token, backend);
        return { token: existing.token };
      }
      const token = randomBytes(32).toString("base64url");
      this.grants.set(token, {
        connectionId: connection.id,
        ...(threadId ? { threadId } : {}),
        ...(backend ? { backend } : {}),
      });
      if (registrationKey && this.bridgeSocketPath) {
        this.threadRegistrations.set(registrationKey, {
          server: this.buildBridgeServer(
            connection.id,
            token,
            this.bridgeSocketPath,
          ),
          token,
        });
      }
      return { token };
    }
    if (operation === "broker/bind") {
      if (
        typeof values.token !== "string"
        || typeof values.threadId !== "string"
      ) {
        throw new Error("Invalid MCP bridge bind request.");
      }
      const grant = this.grants.get(values.token);
      if (!grant) throw new Error("The MCP bridge grant is no longer active.");
      grant.threadId = values.threadId;
      this.announceGrantRoots(values.token, grant);
      for (const [key, registration] of this.threadRegistrations) {
        if (registration.token === values.token) {
          this.threadRegistrations.delete(key);
        }
      }
      if (this.bridgeSocketPath) {
        this.threadRegistrations.set(
          `${grant.connectionId}:${values.threadId}`,
          {
            server: this.buildBridgeServer(
              grant.connectionId,
              values.token,
              this.bridgeSocketPath,
            ),
            token: values.token,
          },
        );
      }
      return true;
    }
    if (operation === "broker/revoke") {
      if (typeof values.token !== "string") {
        throw new Error("Invalid MCP bridge revoke request.");
      }
      const connectionId = this.grants.get(values.token)?.connectionId;
      this.grants.delete(values.token);
      this.relayGrantEpochs.delete(values.token);
      for (const [key, registration] of this.threadRegistrations) {
        if (registration.token === values.token) {
          this.threadRegistrations.delete(key);
        }
      }
      await this.closeUpstreamSession(values.token, true, connectionId);
      return true;
    }
    throw new Error("Unsupported MCP owner broker operation.");
  }

  private gatewaySelectionScope(grant: BridgeGrant): {
    backend: AppServerBackendKind; threadId: string;
    delegation?: { selectionOwner: { backend: AppServerBackendKind; threadId: string }; connectionIds: string[]; grantedConnectionIds?: string[]; readOnly: true };
  } {
    let scope: unknown;
    try { scope = JSON.parse(grant.threadId ?? ""); } catch { /* fail closed below */ }
    const backend = (value: unknown): value is AppServerBackendKind => value === "codex" || value === "claude" || (typeof value === "string" && isAcpBackendId(value));
    const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every((id) => typeof id === "string" && id.length > 0);
    if (!Array.isArray(scope) || (scope.length !== 3 && scope.length !== 4) || scope[0] !== "gateway"
      || !backend(scope[1]) || typeof scope[2] !== "string" || !scope[2]) {
      throw new Error("This bridge is not bound to a gateway thread.");
    }
    if (scope.length === 3) return { backend: scope[1], threadId: scope[2] };
    // This scope is registered through the authenticated owner control plane.
    // MCP tool arguments and bridge invocations cannot supply or replace it.
    const delegated = scope[3];
    if (!delegated || typeof delegated !== "object" || delegated.readOnly !== true
      || !delegated.selectionOwner || !backend(delegated.selectionOwner.backend)
      || typeof delegated.selectionOwner.threadId !== "string" || !delegated.selectionOwner.threadId
      || !ids(delegated.connectionIds)
      || (delegated.grantedConnectionIds !== undefined && !ids(delegated.grantedConnectionIds))) {
      throw new Error("Invalid delegated MCP gateway selection.");
    }
    return { backend: scope[1], threadId: scope[2], delegation: delegated };
  }

  private async requireGatewaySelection(grant: BridgeGrant): Promise<void> {
    const scope = this.gatewaySelectionScope(grant);
    const delegation = scope.delegation;
    const selected = await this.readGatewaySelection(delegation?.selectionOwner ?? scope);
    if ((delegation && !delegation.connectionIds.includes(grant.connectionId))
      || (!selected.includes(grant.connectionId) && !delegation?.grantedConnectionIds?.includes(grant.connectionId))) {
      throw new Error("This connection is no longer selected for the calling thread.");
    }
  }

  private async readGatewayCatalog(
    token: string,
    grant: BridgeGrant,
    client: Client,
    discovery: McpDiscovery,
  ): Promise<McpGatewayTool[]> {
    const connection = this.requireAvailableConnection(grant.connectionId);
    const generation = this.toolInventoryGenerations.get(connection.id) ?? 0;
    const scope = this.gatewaySelectionScope(grant);
    const owner = scope.delegation?.selectionOwner ?? scope;
    const consentEpoch = this.threadConsentEpochs.get(JSON.stringify([connection.id, owner.backend, owner.threadId]));
    const tools: McpGatewayTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = await discovery.phase("tools/list", async () => await client.listTools(
        cursor ? { cursor } : undefined, { signal: discovery.signal, timeout: discovery.remaining() },
      ), page + 1);
      for (const definition of result.tools) {
        bytes += Buffer.byteLength(JSON.stringify(definition));
        if (bytes > 2 * 1024 * 1024 || tools.length >= 2_000) {
          throw new Error("The MCP catalog exceeds the discovery size limit.");
        }
        if (names.has(definition.name)) throw new Error("The MCP server returned duplicate tool names.");
        names.add(definition.name);
        tools.push({
          connectionId: connection.id,
          serverName: connection.displayName,
          toolName: definition.name,
          schemaRevision: gatewayToolRevision(JSON.stringify([token, this.sessionRevisionKey(token, connection.id, client)]), generation, definition),
          consentRevision: gatewayToolRevision(JSON.stringify([this.consentEpoch, connection.id, consentEpoch]), generation, definition),
          definition,
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor) || page === MAX_TOOL_LIST_PAGES - 1) {
        throw new Error("The MCP catalog could not be completely paged.");
      }
      cursors.add(cursor);
    }
    await this.requireGatewaySelection(grant);
    discovery.remaining();
    this.requireAvailableConnection(grant.connectionId);
    if (this.grants.get(token) !== grant
      || generation !== (this.toolInventoryGenerations.get(connection.id) ?? 0)
      || !this.isCurrentUpstream(token, client)) {
      throw new Error("The MCP connection changed during discovery. Search again.");
    }
    this.recordDiscoverySuccess(connection.id);
    if (tools[0]) {
      tools[0] = { ...tools[0], serverIdentity: {
        serverInfo: client.getServerVersion?.(), metadata: this.initializations.get(client)?._meta,
      } };
    }
    // Sandboxer's say to stop each sandbox when done; dropping them left the
    // agent nothing telling it a forgotten machine keeps billing. Only the
    // built-in Sandboxer connection's: a third-party server's instructions would be
    // untrusted text the agent is told to follow.
    const instructions = connection.kind === "sandboxer"
      ? client.getInstructions?.()?.trim()
      : undefined;
    if (instructions && tools[0]) {
      tools[0] = { ...tools[0], serverInstructions: instructions.slice(0, MAX_SERVER_INSTRUCTIONS_CHARS) };
    }
    return tools;
  }

  /**
   * The first page of a server's skills, for the index a host without the
   * skills extension reads as instructions. A failure leaves the index out:
   * the session still opens, and `skills/list` stays available to the host.
   */
  private async listSkillsForIndex(
    grant: BridgeGrant,
    client: Client,
    discovery: McpDiscovery,
  ): Promise<{ skills?: unknown; nextCursor?: unknown } | undefined> {
    try {
      const { ResultSchema } = await mcpTypes.load();
      return await client.request(
        { method: "skills/list", params: {} } as never,
        ResultSchema,
        { signal: discovery.signal, timeout: discovery.remaining() },
      ) as { skills?: unknown; nextCursor?: unknown };
    } catch (error) {
      connectionLog.warn("MCP skills index unavailable", {
        connectionId: grant.connectionId,
        ...discoveryFailure(error, discovery.signal),
      });
      return undefined;
    }
  }

  private async dispatchBridgeOperation(
    token: string,
    grant: BridgeGrant,
    operation: unknown,
    params: unknown,
    signal?: AbortSignal,
    deadlineAt = Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
    parentDiscoveryId?: string,
    /** Where the upstream server's forms for this request go, if anywhere. */
    elicit?: ElicitationRoute,
    /** Where the upstream server's progress reports for a tool call go. */
    onProgress?: (progress: Progress) => void,
    /** `elicit` can also show the upstream server's links. */
    elicitUrl = false,
  ): Promise<unknown> {
    // Net callbacks can inherit the registration that created the server.
    // Only this RPC owns its fetch signal; discovery phases override it locally.
    const dispatch = async (): Promise<unknown> => await mcpRequestSignalContext.run(signal ?? new AbortController().signal, async () => {
      const discovery = new McpDiscovery(grant.connectionId, Math.min(deadlineAt, Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS), signal, {
        threadId: grant.threadId, operation: typeof operation === "string" ? operation : undefined, parentDiscoveryId,
      });
      let releaseRoute: (() => void) | undefined;
      let releaseSession: (() => void) | undefined;
      try {
        if (operation === "gateway/tools/list" || operation === "gateway/tools/call") {
          await this.requireGatewaySelection(grant);
          signal?.throwIfAborted();
        }
        const delegated = grant.threadId?.startsWith("[\"gateway\"") && this.gatewaySelectionScope(grant).delegation;
        if (delegated && operation !== "gateway/tools/list" && operation !== "gateway/tools/call") {
          throw new Error("Delegated MCP access requires the read-only gateway.");
        }
        const readUri = operation === "resources/read" && params && typeof params === "object"
          && typeof (params as { uri?: unknown }).uri === "string"
          ? (params as { uri: string }).uri
          : undefined;
        const upstream = await this.ensureUpstreamClient(token, grant, discovery, {
          operation,
          delegated: Boolean(delegated),
          ...(readUri !== undefined ? { uri: readUri } : {}),
        });
        releaseSession = upstream.release;
        const client = upstream.client;
        // Every request on the session is counted, so a form is never handed
        // to one caller while another may be the one it is for. Only a tool
        // call from a caller that can show it gets a route. A Job Monitor's
        // read-only scope has no one to ask.
        const interactive = !delegated && (operation === "tools/call" || operation === "gateway/tools/call");
        releaseRoute = this.elicitationRoutes.track(
          token,
          client,
          signal ?? discovery.signal,
          interactive ? elicit : undefined,
          {
            url: interactive && elicitUrl,
            // Only a native host knows the link's id, so only it is told the
            // server's flow finished. `call_mcp_tool` has no card left to update.
            ...(operation === "tools/call"
              ? { onUrlOpened: (elicitationId: string) => this.rememberOpenedUrlElicitation(token, client, elicitationId) }
              : {}),
          },
        );
        const values = params && typeof params === "object"
          ? params as Record<string, unknown>
          : {};
        const { ErrorCode, McpError } = await mcpTypes.load();
        switch (operation) {
          case "gateway/tools/list":
            return await this.readGatewayCatalog(token, grant, client, discovery);
          case "gateway/tools/call": {
            const catalog = await this.readGatewayCatalog(token, grant, client, discovery);
            const tool = catalog.find((entry) => entry.toolName === values.toolName);
            if (!tool || values.connectionId !== grant.connectionId) {
              throw new McpError(ErrorCode.InvalidParams, "The selected MCP tool is no longer available. Search again.");
            }
            if (tool.schemaRevision !== values.schemaRevision) {
              throw new McpError(ErrorCode.InvalidParams, "The MCP tool schema or authorization changed. Search again before calling.");
            }
            if (!values.arguments || typeof values.arguments !== "object" || Array.isArray(values.arguments)) {
              throw new McpError(ErrorCode.InvalidParams, "Tool arguments must be an object.");
            }
            if (delegated && (tool.definition.annotations?.readOnlyHint !== true || tool.definition.annotations.destructiveHint === true)) {
              throw new Error("Job Monitors may invoke only explicitly read-only MCP tools.");
            }
            await validateGatewayArguments(tool.definition, values.arguments as Record<string, unknown>);
            signal?.throwIfAborted();
            discovery.close();
            let result: Awaited<ReturnType<Client["callTool"]>>;
            try {
              result = await client.callTool({ name: tool.toolName, arguments: values.arguments as Record<string, unknown> },
                undefined, upstreamToolCallOptions(signal, onProgress));
            } catch (error) {
              if (error instanceof McpError && error.code === ErrorCode.UrlElicitationRequired && interactive && elicitUrl) {
                throw await this.offerRequiredUrlElicitations(token, client, error, signal);
              }
              throw error;
            }
            this.observeToolResult(grant, tool.toolName, result as CallToolResult);
            this.pwrSnapMediaLinks.record(token, grant.connectionId, client, result);
            return result;
          }
          case "describe": {
            const capabilities = client.getServerCapabilities();
            const skills = offersMcpSkills(capabilities);
            const instructions = client.getInstructions?.();
            return {
              tools: Boolean(capabilities?.tools),
              resources: Boolean(capabilities?.resources),
              prompts: Boolean(capabilities?.prompts),
              skills,
              capabilities,
              serverInfo: client.getServerVersion?.(),
              instructions: skills && !instructions?.trim()
                ? skillsAwareInstructions({ instructions, listed: await this.listSkillsForIndex(grant, client, discovery) })
                : instructions,
              metadata: this.initializations.get(client)?._meta,
            };
          }
          case "tools/list": {
            const result = await discovery.phase("tools/list", async () => await client.listTools(values, { signal: discovery.signal, timeout: discovery.remaining() }), 1);
            if (!result.nextCursor) this.recordDiscoverySuccess(grant.connectionId);
            return result;
          }
          case "tools/call": {
            let result: Awaited<ReturnType<Client["callTool"]>>;
            try {
              result = await client.callTool(
                values as Parameters<Client["callTool"]>[0],
                undefined,
                upstreamToolCallOptions(signal, onProgress),
              );
            } catch (error) {
              // The error reaches the host unchanged. A host that can show
              // links may open them itself, so it is told when each finishes.
              if (error instanceof McpError && error.code === ErrorCode.UrlElicitationRequired && interactive && elicitUrl) {
                for (const elicitationId of requiredUrlElicitationIds(error)) {
                  this.rememberOpenedUrlElicitation(token, client, elicitationId);
                }
              }
              throw error;
            }
            this.observeToolResult(grant, values.name, result as CallToolResult);
            this.pwrSnapMediaLinks.record(token, grant.connectionId, client, result);
            return result;
          }
          // The caller's cancel reaches the server; it no longer waits out
          // the SDK's default timeout.
          case "resources/list":
            return await client.listResources(values, cancelOnly(signal));
          case "resources/templates/list":
            return await client.listResourceTemplates(values, cancelOnly(signal));
          case "resources/read":
            return await client.readResource(
              values as Parameters<Client["readResource"]>[0],
              cancelOnly(signal),
            );
          case "resources/subscribe":
            return await client.subscribeResource(values as Parameters<Client["subscribeResource"]>[0], cancelOnly(signal));
          case "resources/unsubscribe":
            return await client.unsubscribeResource(values as Parameters<Client["unsubscribeResource"]>[0], cancelOnly(signal));
          case "prompts/list":
            return await client.listPrompts(values, cancelOnly(signal));
          case "prompts/get":
            return await client.getPrompt(
              values as Parameters<Client["getPrompt"]>[0],
              cancelOnly(signal),
            );
          case "skills/list":
          case "skills/get":
          case "resources/directory/read": {
            // Only to a server that offered the extension. The SDK's request
            // union has no skills methods, so the result passes through whole.
            if (!offersMcpSkills(client.getServerCapabilities())) {
              throw new McpError(ErrorCode.MethodNotFound, "This MCP server does not offer skills.");
            }
            const { ResultSchema } = await mcpTypes.load();
            return await client.request(
              { method: operation, params: values } as never,
              ResultSchema,
              cancelOnly(signal),
            );
          }
          default:
            throw new Error("unsupported MCP operation");
        }
      } catch (error) {
        this.recordDiscoveryFailure(grant.connectionId, error);
        throw error;
      } finally {
        releaseRoute?.();
        releaseSession?.();
        discovery.close();
      }
    });
    return await mcpDiscoveryContext.exit(async () => await mcpDiscoveryPhaseContext.exit(dispatch));
  }

  /**
   * Every Sandboxer tool call reaches the upstream server here, on the
   * profile's owner, whether it came through a thread's native MCP bridge or
   * `call_mcp_tool`. A successful `create_sandbox` is recorded against the
   * calling thread. Recording never affects the call's result.
   */
  private observeToolResult(
    grant: BridgeGrant,
    toolName: unknown,
    result: CallToolResult,
  ): void {
    if (grant.connectionId !== SANDBOXER_MCP_CONNECTION_ID || toolName !== "create_sandbox") return;
    const thread = readGrantThread(grant.threadId);
    if (!thread) return;
    try {
      const sandbox = readCreatedSandbox(result);
      if (!sandbox) return;
      this.recordCreatedSandbox({
        connectionId: grant.connectionId,
        ...sandbox,
        ...thread,
        now: Date.now(),
      });
    } catch (error) {
      connectionLog.warn("failed to record a created sandbox", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A tool session for PwrAgent's own calls, such as releasing a closed PR's
   * sandboxes. It uses the same owner-broker path as an agent's call, so it
   * works for a local process or a hosted endpoint alike, but it is not tied
   * to a thread's MCP selection: the operator's cleanup switch governs it.
   * The connection must still be enabled and signed in. Close it when done.
   */
  async openPwrAgentToolSession(params: {
    connectionId: string;
    scopeKey: string;
    signal: AbortSignal;
  }): Promise<SandboxerCleanupTransport> {
    const registration = await this.registerBridge(
      params.connectionId,
      params.scopeKey,
      params.signal,
    );
    const rpc = new ConnectionRpcClient(
      registration.server.env.PWRAGENT_MCP_CONNECTION_SOCKET,
      registration.server.env.PWRAGENT_MCP_CONNECTION_TOKEN,
    );
    return {
      listToolNames: async () => {
        const names: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const result = await rpc.request(
            "tools/list",
            cursor ? { cursor } : {},
            params.signal,
            Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
          ) as { tools?: Array<{ name?: unknown }>; nextCursor?: unknown };
          for (const tool of result.tools ?? []) {
            if (typeof tool.name === "string") names.push(tool.name);
          }
          cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
          if (!cursor) break;
        }
        return names;
      },
      callTool: async (name, args) => await rpc.request(
        "tools/call",
        { name, arguments: args },
        params.signal,
        undefined,
        undefined,
        MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
      ) as CallToolResult,
      close: () => registration.revoke(),
    };
  }

  private respond(socket: Socket, response: BridgeResponse): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }
}

/**
 * The thread a grant serves. A thread's own bridge carries the bare id; the
 * gateway search/call path carries `["gateway", backend, threadId]`.
 */
function grantThreadId(grant: BridgeGrant): string | undefined {
  if (!grant.threadId) return undefined;
  if (!grant.threadId.startsWith("[")) return grant.threadId;
  try {
    const scope = JSON.parse(grant.threadId) as unknown;
    return Array.isArray(scope) && scope[0] === "gateway" && typeof scope[2] === "string"
      ? scope[2]
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The thread whose directories a scope's sessions are given. A gateway scope
 * names its backend; a native bridge's bare thread id takes the backend it
 * was registered with. Without both there are no roots.
 */
function threadRootsScope(
  scopeKey: string | undefined,
  backend: AppServerBackendKind | undefined,
): ThreadRootsScope | undefined {
  const thread = readGrantThread(scopeKey);
  const threadBackend = (thread?.backend as AppServerBackendKind | undefined) ?? backend;
  return thread && threadBackend ? { backend: threadBackend, threadId: thread.threadId } : undefined;
}

/** The link ids a `-32042` error lists, as the server sent them. */
function requiredUrlElicitationIds(error: McpError): string[] {
  const listed = (error.data as { elicitations?: unknown } | undefined)?.elicitations;
  if (!Array.isArray(listed)) return [];
  return listed.slice(0, MAX_OPENED_URL_ELICITATIONS).flatMap((entry) => {
    const id = entry && typeof entry === "object" ? (entry as { elicitationId?: unknown }).elicitationId : undefined;
    return typeof id === "string" && id ? [id] : [];
  });
}

function grantRootsKey(grant: BridgeGrant): string | undefined {
  const scope = threadRootsScope(grant.threadId, grant.backend);
  return scope ? buildThreadIdentityKey(scope.backend, scope.threadId) : undefined;
}

function sameSecretValues(
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
): boolean {
  if (!previous) return false;
  const names = Object.keys(next);
  return names.length === Object.keys(previous).length
    && names.every((name) => Object.hasOwn(previous, name) && previous[name] === next[name]);
}

function hasStdioSecretStore(
  settings: GatewaySettings,
): settings is GatewaySettings & McpStdioSecretSettings {
  const candidate = settings as Partial<Record<string, unknown>>;
  return typeof candidate.resolveMcpStdioConnectionSecrets === "function"
    && typeof candidate.saveMcpStdioConnectionSecrets === "function"
    && typeof candidate.clearMcpStdioConnectionSecrets === "function";
}

function secureTokenEqual(candidate: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

let mcpConnectionGatewayService: McpConnectionGatewayService | undefined;

/**
 * The thread a grant serves. Gateway calls carry `["gateway", backend,
 * threadId]`; a thread's native bridge carries the bare thread id. Settings
 * discovery and PwrAgent's own sessions name no thread.
 */
function readGrantThread(
  scope: string | undefined,
): { backend?: string; threadId: string } | undefined {
  const value = scope?.trim();
  if (!value) return undefined;
  if (!value.startsWith("[")) return { threadId: value };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed)
      && (parsed.length === 3 || parsed.length === 4)
      && parsed[0] === "gateway"
      && typeof parsed[1] === "string"
      && typeof parsed[2] === "string"
      && parsed[2]
    ) {
      return { backend: parsed[1], threadId: parsed[2] };
    }
  } catch {
    // Not a thread scope.
  }
  return undefined;
}

export function initializeMcpConnectionGatewayService(): McpConnectionGatewayService {
  mcpConnectionGatewayService ??= new McpConnectionGatewayService();
  return mcpConnectionGatewayService;
}

export async function resetMcpConnectionGatewayServiceForTests(): Promise<void> {
  await mcpConnectionGatewayService?.close();
  mcpConnectionGatewayService = undefined;
}

export function getMcpConnectionGatewayService(): McpConnectionGatewayService {
  if (!mcpConnectionGatewayService) throw new Error("getMcpConnectionGatewayService is unavailable before startOwnerServices().");
  return mcpConnectionGatewayService;
}

export function getExistingMcpConnectionGatewayService(): McpConnectionGatewayService | undefined {
  return mcpConnectionGatewayService;
}
