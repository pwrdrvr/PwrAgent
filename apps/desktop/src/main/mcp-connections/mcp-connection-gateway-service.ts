import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect,
  createServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { shell } from "electron";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema, PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, type InitializeResult, type Notification, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpInitializationTransport } from "./mcp-initialization-transport";
import { McpDiscovery, McpDiscoveryError, mcpDiscoveryContext, mcpDiscoveryPhaseContext, mcpRequestSignalContext, waitForMcp } from "./mcp-discovery";
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
import { ConnectionRpcClient } from "./mcp-connection-rpc-client";
import { gatewayToolRevision, validateGatewayArguments, type McpGatewayTool, type McpGatewayInvocation } from "./mcp-gateway-catalog";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
  PWRSNAP_SESSION_REVOKED_DETAIL,
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
import { getAppStateDb, getAppStateMode, getAppOverlayStore } from "../state/app-state";
import { ThreadSandboxStore } from "../state/thread-sandbox-store";
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
import {
  McpOAuthSessionCoordinator,
  McpReauthorizationRequiredError,
} from "./mcp-oauth-session-coordinator";
import { createMcpSafeFetch } from "./mcp-safe-fetch";
import { probeMcpConnectionUrl } from "./mcp-connection-probe";
import {
  MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_TIMEOUT_MS,
} from "./mcp-connection-timeouts";

const connectionLog = getMainLogger("pwragent:mcp-connections");
const PWRSNAP_MCP_URL = new URL("http://127.0.0.1:51729/mcp");
const PWRSNAP_DOWNLOAD_URL =
  "https://github.com/pwrdrvr/PwrSnap/releases/latest";
const PWRSNAP_SCOPES = [
  "library.read",
  "capture.composite.read",
  "capture.original.read",
  "capture.export",
  "capture.edit",
  "trash.write",
  "sizzle.compose",
  "sizzle.preview.read",
  "sizzle.full.read",
].join(" ");
/** Returned to agents through the bridge, where no Connect button is visible. */
export const PWRSNAP_SESSION_REVOKED_ERROR =
  "PwrSnap revoked this connection. PwrSnap tools stay unavailable until the operator chooses Connect to PwrSnap on New thread in PwrAgent.";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_RPC_LINE_BYTES = 1024 * 1024;
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
const GATEWAY_OFF_ERROR =
  "The PwrAgent MCP gateway is turned off. Turn it on in Settings → Plugins to use managed connections.";

type BridgeGrant = {
  connectionId: string;
  threadId?: string;
};

type UpstreamSession = {
  client: Client;
  transport: Transport;
};

type BridgeRequest = {
  token?: unknown;
  brokerToken?: unknown;
  op?: unknown;
  params?: unknown;
  deadlineAt?: unknown;
  discoveryId?: unknown;
};

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
  readGatewaySelection?: (context: { backend: AppServerBackendKind; threadId: string }) => Promise<string[]>;
  bridgeEntryPath?: string;
  fetchFn?: FetchLike;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  resolveInstallPaths?: () => string[];
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

function resolveDefaultPwrSnapInstallPaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/PwrSnap.app",
      join(homedir(), "Applications", "PwrSnap.app"),
    ];
  }
  if (process.platform === "win32") {
    return [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Programs", "PwrSnap", "PwrSnap.exe")
        : "",
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "PwrSnap", "PwrSnap.exe")
        : "",
      process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"]!, "PwrSnap", "PwrSnap.exe")
        : "",
    ].filter(Boolean);
  }
  return [
    "/usr/bin/pwrsnap",
    "/opt/PwrSnap/pwrsnap",
    join(homedir(), "Applications", "PwrSnap.AppImage"),
  ];
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
    ...(typeof process.resourcesPath === "string"
      ? [join(process.resourcesPath, fileName)]
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
  private readonly readGatewaySelection: NonNullable<McpConnectionGatewayServiceOptions["readGatewaySelection"]>;
  private readonly bridgeEntryPath: string;
  private readonly fetchFn: FetchLike;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly openPath: (path: string) => Promise<string>;
  private readonly resolveInstallPaths: () => string[];
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
  private sessionRevoked = false;
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
  private readonly recordCreatedSandbox: NonNullable<McpConnectionGatewayServiceOptions["recordCreatedSandbox"]>;

  constructor(options: McpConnectionGatewayServiceOptions = {}) {
    this.recordCreatedSandbox = options.recordCreatedSandbox
      ?? ((params) => {
        if (!getAppStateMode()) return;
        new ThreadSandboxStore(getAppStateDb().raw).recordCreated(params);
      });
    this.readGatewaySelection = options.readGatewaySelection
      ?? (async (context) => (await getAppOverlayStore().getThreadOverlayState(context))?.mcpConnectionIds ?? []);
    this.bridgeEntryPath =
      options.bridgeEntryPath ?? join(__dirname, "mcp-connection-bridge.js");
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
    this.sandboxer = options.sandboxer
      ?? new SandboxerConnection(undefined, { openExternal: this.openExternal });
    this.sandboxer.onStatusChanged(() => this.announceChanged([SANDBOXER_MCP_CONNECTION_ID]));
    this.openPath = options.openPath ?? ((path) => shell.openPath(path));
    this.resolveInstallPaths =
      options.resolveInstallPaths ?? resolveDefaultPwrSnapInstallPaths;
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
    const [configured, endpointAvailable] = await Promise.all([
      this.coordinatorFor(this.requireConnection(PWRSNAP_MCP_CONNECTION_ID))
        .configured(),
      this.isEndpointAvailable(),
    ]);
    const installed = endpointAvailable || Boolean(this.findInstalledPath());
    const details: string[] = [];
    if (!configured && this.sessionRevoked) {
      details.push(PWRSNAP_SESSION_REVOKED_DETAIL);
    }
    if (!endpointAvailable && installed) {
      details.push("Open PwrSnap and enable Local Agent Access to connect agents.");
    }
    const detail = details.join(" ");
    return {
      connectionId: PWRSNAP_MCP_CONNECTION_ID,
      displayName: "PwrSnap",
      availability: endpointAvailable
        ? "running"
        : installed
          ? "installed"
          : "not_installed",
      configured,
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
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/create",
        request,
      ));
    }
    if (request.stdio !== undefined) {
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
    const connection = this.registry.create({
      displayName: request.displayName,
      serverUrl: request.serverUrl,
    });
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
          || (error instanceof McpError && error.code === ErrorCode.RequestTimeout),
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
    if (connection.kind === "stdio") {
      throw new Error(`${connection.displayName} is a local command. It has nothing to sign in to.`);
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
      if (connection.id === PWRSNAP_MCP_CONNECTION_ID) {
        this.sessionRevoked = false;
        await this.settings.clearPwrSnapMcpCredential();
      }
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
    if (connection.authMode === "local_cli" || connection.kind === "stdio") return this.announced(await this.connectionStatus(connection));
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
      return this.announced(await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/update",
        request,
      ));
    }
    const existing = this.requireConnection(request.connectionId);
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
      await this.coordinatorFor(existing).disconnect();
      this.coordinators.delete(request.connectionId);
      this.invalidateConnectionTools(request.connectionId);
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
    if (connection.kind === "sandboxer" && connection.authMode === "local_cli") {
      return this.announced(await this.connectionStatus(this.registry.setEnabled(connectionId, false)));
    }
    // A local command holds no credentials to discard; stopping its running
    // copies is all a disconnect can mean.
    if (connection.kind === "stdio") return this.announced(await this.connectionStatus(connection));
    await this.coordinatorFor(connection).disconnect();
    this.invalidateConnectionTools(connectionId);
    if (connection.id === PWRSNAP_MCP_CONNECTION_ID) {
      this.sessionRevoked = false;
      await this.settings.clearPwrSnapMcpCredential();
    }
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
    await this.coordinatorFor(connection).disconnect();
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
    if (
      !configured
      && !(connection.id === PWRSNAP_MCP_CONNECTION_ID && this.sessionRevoked)
    ) {
      throw new Error(
        connection.authMode === "local_cli" || connection.kind === "stdio" ? status.detail
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
      return this.registrationHandle(existing.token, existing.server, registrationKey);
    }
    await this.startBridgeServer();
    signal?.throwIfAborted();
    // Another call may have registered this same scope during broker startup.
    const started = registrationKey ? this.threadRegistrations.get(registrationKey) : undefined;
    if (started && this.grants.has(started.token)) {
      return this.registrationHandle(started.token, started.server, registrationKey);
    }
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, { connectionId, threadId });
    const socketPath = this.bridgeSocketPath;
    if (!socketPath) {
      this.grants.delete(token);
      throw new Error("The PwrAgent MCP bridge is unavailable.");
    }
    const server = this.buildBridgeServer(connectionId, token, socketPath);
    if (registrationKey) {
      this.threadRegistrations.set(registrationKey, { server, token });
    }
    return this.registrationHandle(token, server, registrationKey);
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
      return await rpc.request(
        params.operation, params.invocation, params.signal, discovery.deadlineAt, discovery.id,
        params.operation === "gateway/tools/call" ? MCP_CONNECTION_TOOL_TIMEOUT_MS : undefined,
      ) as McpGatewayTool[] | CallToolResult;
    } finally {
      discovery.close();
    }
  }

  private registrationHandle(
    token: string,
    server: McpConnectionBridgeServer,
    registrationKey?: string,
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
      },
      revoke: () => {
        this.grants.delete(token);
        void this.closeUpstreamSession(token);
        if (currentRegistrationKey) {
          this.threadRegistrations.delete(currentRegistrationKey);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.grants.clear();
    this.threadRegistrations.clear();
    for (const sockets of this.bridgeAttachments.values()) {
      for (const socket of sockets) socket.destroy();
    }
    this.bridgeAttachments.clear();
    this.bridgeAttachmentCount = 0;
    await Promise.all([...this.stdioTestTransports].map(async (transport) =>
      await transport.close().catch(() => undefined)));
    this.stdioTestTransports.clear();
    await Promise.all(
      [...new Set([...this.upstreamSessions.keys(), ...this.upstreamStarts.keys()])].map(async (token) =>
        await this.closeUpstreamSession(token),
      ),
    );
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
  ): Promise<T> {
    try {
      return await this.requestBrokerRecord<T>(
        this.readOwnerBrokerRecord(holder),
        operation,
        params,
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
        if (buffer.length > MAX_RPC_LINE_BYTES) {
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
  ): Promise<McpConnectionBridgeRegistration> {
    let record: McpConnectionBrokerRecord;
    let result: { token: string };
    try {
      record = this.readOwnerBrokerRecord(holder);
      result = await this.requestBrokerRecord<{ token: string }>(
        record,
        "broker/register",
        { connectionId, threadId },
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
    if (!(await this.isEndpointAvailable())) {
      return {
        outcome: "needs_local_agent_access",
        status: await this.readStatus(),
      };
    }

    await this.authorizeConnection(PWRSNAP_MCP_CONNECTION_ID);
    return { outcome: "connected", status: await this.readStatus() };
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

  private async isEndpointAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchFn(PWRSNAP_MCP_URL, {
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok || response.status === 401 || response.status === 405;
    } catch {
      return false;
    }
  }

  private findInstalledPath(): string | undefined {
    return this.resolveInstallPaths().find((candidate) => existsSync(candidate));
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
        ...(connection.kind === "pwrsnap" ? { scope: PWRSNAP_SCOPES } : {}),
        ...(connection.kind === "sandboxer" ? { scope: "sandboxer" } : {}),
        ...(connection.kind === "pwrgit" ? {
          scope: "repository.roots.read repository.checkout.locate repository.metadata.read forge.status.read status.subscribe",
          discardRejectedCredentials: true,
          onCredentialRejected: async () => await this.settings.clearPwrGitMcpCredential(),
        } : {}),
        vault: this.credentialVault,
        fetchFn: createMcpSafeFetch({
          fetchFn: this.fetchFn,
          connectionId: connection.id,
        }),
        ...(connection.kind === "pwrsnap"
          ? {
              discardRejectedCredentials: true,
              onCredentialRejected: async () => {
                this.sessionRevoked = true;
                await this.settings.clearPwrSnapMcpCredential();
              },
            }
          : {}),
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
    if (!(error instanceof McpDiscoveryError)) return;
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
  ): Promise<Client> {
    const connection = this.requireAvailableConnection(grant.connectionId);
    discovery.remaining();
    const existing = this.upstreamSessions.get(token);
    if (existing) return existing.client;
    if (this.disconnectedStdioGrants.has(token)) {
      throw new Error("The MCP desktop connection ended. Start the desktop yourself, then turn this connection off and on in the thread MCP access panel. Search tools again and reread relevant skills/resources. Previously injected text may remain in the conversation. Never replay a write or reuse its approval.");
    }
    let pending = this.upstreamStarts.get(token);
    if (!pending) {
      const controller = new AbortController();
      const startDiscovery = new McpDiscovery(connection.id, Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS, controller.signal);
      const start = { controller, waiters: 0, discoveryId: startDiscovery.id, promise: undefined as unknown as Promise<Client> };
      start.promise = startDiscovery.phase("initialize", async () => await this.openUpstreamSession(token, connection, startDiscovery)).finally(() => {
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
      return await discovery.phase("initialize", async () => await waitForMcp(start.promise, discovery.signal));
    } finally {
      start.waiters -= 1;
      if (start.waiters === 0 && this.upstreamStarts.get(token) === start) {
        this.upstreamStarts.delete(token);
        start.controller.abort(new DOMException("All MCP initialization waiters left.", "AbortError"));
      }
    }
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
      for (const [token, session] of this.upstreamSessions) {
        if (session.client === client) this.sendBridgeEvent(token, notification);
      }
    };
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
      // A session evicts itself when it actually dies. Leaving that to the
      // per-request error path would close a healthy session shared by every
      // in-flight request on this token the first time one of them was
      // cancelled or answered with an ordinary JSON-RPC error.
      onClose: (client) => {
        if (this.upstreamSessions.get(token)?.client === client) {
          this.upstreamSessions.delete(token);
          this.evictConnectionToolInventory(connection.id);
          if (connection.kind === "stdio") this.disconnectedStdioGrants.add(token);
          this.sendBridgeEvent(token, { method: "connection/closed" });
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
   * both get the same credential check and the same PwrSnap revocation
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
    },
  ): Promise<UpstreamSession> {
    let transport: Transport;
    if (connection.kind === "stdio") {
      return await this.connectStdioClient(connection, options);
    }
    if (connection.kind === "sandboxer" && connection.authMode === "local_cli") {
      const status = await this.sandboxer.readStatus();
      if (!status.configured) throw new Error(status.detail);
      transport = this.sandboxer.createTransport();
    } else {
      const coordinator = this.coordinatorFor(connection);
      if (!(await coordinator.configured())) {
        throw new Error(
          connection.id === PWRSNAP_MCP_CONNECTION_ID && this.sessionRevoked
            ? PWRSNAP_SESSION_REVOKED_ERROR
            : `${connection.displayName} needs to be reauthorized in Settings → Plugins.`,
        );
      }
      transport = new StreamableHTTPClientTransport(
        new URL(connection.serverUrl),
        { fetch: coordinator.authorizedFetch() },
      );
    }
    const client = new Client(
      {
        name: options.clientName,
        version: "1.0.0",
      },
      { capabilities: {} },
    );
    this.installDiscoveryNotifications(client, connection);
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
      if (connection.id === PWRSNAP_MCP_CONNECTION_ID) {
        await this.settings.clearPwrSnapMcpCredential();
      }
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (
        connection.id === PWRSNAP_MCP_CONNECTION_ID
        && (this.sessionRevoked
          || error instanceof McpReauthorizationRequiredError)
      ) {
        throw new Error(PWRSNAP_SESSION_REVOKED_ERROR, { cause: error });
      }
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
    options: {
      clientName: string;
      onClose?: (client: Client) => void;
      discovery: McpDiscovery;
      threadSession?: boolean;
    },
  ): Promise<UpstreamSession> {
    const launch = connection.stdio;
    if (!launch) throw new Error(`${connection.displayName} has no command to run.`);
    let transport: OwnedStdioClientTransport | undefined;
    const client = new Client({ name: options.clientName, version: "1.0.0" }, { capabilities: {} });
    this.installDiscoveryNotifications(client, connection);
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
          || (error instanceof McpError && error.code === ErrorCode.RequestTimeout),
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

  private async closeUpstreamSession(token: string, resetDisconnected = true): Promise<void> {
    if (resetDisconnected) this.disconnectedStdioGrants.delete(token);
    const start = this.upstreamStarts.get(token);
    this.upstreamStarts.delete(token);
    start?.controller.abort(new DOMException("MCP session closed.", "AbortError"));
    const session = this.upstreamSessions.get(token);
    this.upstreamSessions.delete(token);
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
    await Promise.all(
      [...new Set([...this.upstreamSessions.keys(), ...this.upstreamStarts.keys()])].map(
        async (token) => await this.closeUpstreamSession(token),
      ),
    );
  }

  private async closeConnectionSessions(connectionId: string): Promise<void> {
    // Invalidate before awaiting close, including sessions still opening.
    this.invalidateConnectionTools(connectionId);
    await Promise.all(
      [...this.grants.entries()]
        .filter(([, grant]) => grant.connectionId === connectionId)
        .map(async ([token]) => await this.closeUpstreamSession(token)),
    );
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
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RPC_LINE_BYTES) {
        this.respond(socket, { ok: false, error: "request too large" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void this.handleBridgeLine(socket, line);
    });
    socket.on("error", () => socket.destroy());
  }

  private async handleBridgeLine(socket: Socket, line: string): Promise<void> {
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
    try {
      const result = await this.dispatchBridgeOperation(
        request.token,
        grant,
        request.op,
        request.params,
        abortController.signal,
        typeof request.deadlineAt === "number" && Number.isFinite(request.deadlineAt) ? request.deadlineAt : undefined,
        typeof request.discoveryId === "string" && /^[a-f0-9-]{36}$/.test(request.discoveryId) ? request.discoveryId : undefined,
      );
      this.respond(socket, { ok: true, result });
    } catch (error) {
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
        ...(error instanceof McpDiscoveryError ? { diagnostic: error.data } : {}),
      });
      this.respond(socket, {
        ok: false,
        error: message,
        ...(error instanceof McpError ? { code: error.code, data: error.data } : {}),
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
      if (this.registry.get(grant.connectionId)?.kind === "stdio") {
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
      if (existing && this.grants.has(existing.token)) {
        return { token: existing.token };
      }
      const token = randomBytes(32).toString("base64url");
      this.grants.set(token, {
        connectionId: connection.id,
        ...(threadId ? { threadId } : {}),
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
      this.grants.delete(values.token);
      for (const [key, registration] of this.threadRegistrations) {
        if (registration.token === values.token) {
          this.threadRegistrations.delete(key);
        }
      }
      await this.closeUpstreamSession(values.token);
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
          schemaRevision: gatewayToolRevision(JSON.stringify([token, this.sessionIdentities.get(client)]), generation, definition),
          consentRevision: gatewayToolRevision(JSON.stringify([this.consentEpoch, connection.id]), generation, definition),
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
      || this.upstreamSessions.get(token)?.client !== client) {
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

  private async dispatchBridgeOperation(
    token: string,
    grant: BridgeGrant,
    operation: unknown,
    params: unknown,
    signal?: AbortSignal,
    deadlineAt = Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS,
    parentDiscoveryId?: string,
  ): Promise<unknown> {
    // Net callbacks can inherit the registration that created the server.
    // Only this RPC owns its fetch signal; discovery phases override it locally.
    const dispatch = async (): Promise<unknown> => await mcpRequestSignalContext.run(signal ?? new AbortController().signal, async () => {
      const discovery = new McpDiscovery(grant.connectionId, Math.min(deadlineAt, Date.now() + MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS), signal, {
        threadId: grant.threadId, operation: typeof operation === "string" ? operation : undefined, parentDiscoveryId,
      });
      try {
        if (operation === "gateway/tools/list" || operation === "gateway/tools/call") {
          await this.requireGatewaySelection(grant);
          signal?.throwIfAborted();
        }
        const delegated = grant.threadId?.startsWith("[\"gateway\"") && this.gatewaySelectionScope(grant).delegation;
        if (delegated && operation !== "gateway/tools/list" && operation !== "gateway/tools/call") {
          throw new Error("Delegated MCP access requires the read-only gateway.");
        }
        const client = await this.ensureUpstreamClient(token, grant, discovery);
        const values = params && typeof params === "object"
          ? params as Record<string, unknown>
          : {};
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
            validateGatewayArguments(tool.definition, values.arguments as Record<string, unknown>);
            signal?.throwIfAborted();
            discovery.close();
            const result = await client.callTool({ name: tool.toolName, arguments: values.arguments as Record<string, unknown> },
              undefined, { signal, timeout: MCP_CONNECTION_TOOL_TIMEOUT_MS });
            this.observeToolResult(grant, tool.toolName, result as CallToolResult);
            return result;
          }
          case "describe": {
            const capabilities = client.getServerCapabilities();
            return {
              tools: Boolean(capabilities?.tools),
              resources: Boolean(capabilities?.resources),
              prompts: Boolean(capabilities?.prompts),
              capabilities,
              serverInfo: client.getServerVersion?.(),
              instructions: client.getInstructions?.(),
              metadata: this.initializations.get(client)?._meta,
            };
          }
          case "tools/list": {
            const result = await discovery.phase("tools/list", async () => await client.listTools(values, { signal: discovery.signal, timeout: discovery.remaining() }), 1);
            if (!result.nextCursor) this.recordDiscoverySuccess(grant.connectionId);
            return result;
          }
          case "tools/call": {
            const result = await client.callTool(
              values as Parameters<Client["callTool"]>[0],
              undefined,
              {
                ...(signal ? { signal } : {}),
                timeout: MCP_CONNECTION_TOOL_TIMEOUT_MS,
              },
            );
            this.observeToolResult(grant, values.name, result as CallToolResult);
            return result;
          }
          case "resources/list":
            return await client.listResources(values);
          case "resources/templates/list":
            return await client.listResourceTemplates(values);
          case "resources/read":
            return await client.readResource(
              values as Parameters<Client["readResource"]>[0],
            );
          case "resources/subscribe":
            return await client.subscribeResource(values as Parameters<Client["subscribeResource"]>[0]);
          case "resources/unsubscribe":
            return await client.unsubscribeResource(values as Parameters<Client["unsubscribeResource"]>[0]);
          case "prompts/list":
            return await client.listPrompts(values);
          case "prompts/get":
            return await client.getPrompt(
              values as Parameters<Client["getPrompt"]>[0],
            );
          default:
            throw new Error("unsupported MCP operation");
        }
      } catch (error) {
        this.recordDiscoveryFailure(grant.connectionId, error);
        throw error;
      } finally {
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

export function getMcpConnectionGatewayService(): McpConnectionGatewayService {
  mcpConnectionGatewayService ??= new McpConnectionGatewayService();
  return mcpConnectionGatewayService;
}

export async function resetMcpConnectionGatewayServiceForTests(): Promise<void> {
  await mcpConnectionGatewayService?.close();
  mcpConnectionGatewayService = undefined;
}
