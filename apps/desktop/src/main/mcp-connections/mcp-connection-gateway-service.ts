import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
  PWRSNAP_SESSION_REVOKED_DETAIL,
  type CreateMcpConnectionRequest,
  type ProbeMcpConnectionRequest,
  type ProbeMcpConnectionResponse,
  type UpdateMcpConnectionRequest,
  type McpConnectionRecord,
  type McpConnectionStatus,
  type ConnectPwrSnapResponse,
  type OpenPwrSnapResponse,
  type PwrSnapConnectionStatus,
} from "@pwragent/shared";
import { isSafeExternalOpenUrl } from "../external-url-policy";
import { getMainLogger } from "../log";
import {
  getRuntimeLeaseManager,
  type RuntimeLeaseManager,
  type RuntimeLeaseHolder,
} from "../runtime-lease-manager";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getAppStateMode } from "../state/app-state";
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
import { MCP_CONNECTION_TOOL_TIMEOUT_MS } from "./mcp-connection-timeouts";

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

type BridgeGrant = {
  connectionId: string;
  threadId?: string;
};

type UpstreamSession = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

type BridgeRequest = {
  token?: unknown;
  brokerToken?: unknown;
  op?: unknown;
  params?: unknown;
};

type BridgeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

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
  bridgeEntryPath?: string;
  fetchFn?: FetchLike;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  launchPollAttempts?: number;
  launchPollDelayMs?: number;
  resolveInstallPaths?: () => string[];
  settings?: GatewaySettings;
  registry?: McpConnectionRegistry;
  credentialVault?: McpCredentialVault;
  leaseManager?: Pick<
    RuntimeLeaseManager,
    "acquire" | "id" | "release" | "snapshot"
  > | null;
  brokerDiscovery?: McpConnectionBrokerDiscovery;
  /** Profile-wide gateway switch; defaults to the desktop setting. */
  gatewayEnabled?: () => boolean;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    | Pick<RuntimeLeaseManager, "acquire" | "id" | "release" | "snapshot">
    | null;
  private readonly brokerDiscovery: McpConnectionBrokerDiscovery;
  private readonly launchPollAttempts: number;
  private readonly launchPollDelayMs: number;
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
  private readonly upstreamStarts = new Map<string, Promise<Client>>();
  private connectPromise?: Promise<ConnectPwrSnapResponse>;
  private sessionRevoked = false;
  private leaseHeld = false;
  private brokerToken?: string;
  private nonOwnerHolder?: RuntimeLeaseHolder;

  constructor(options: McpConnectionGatewayServiceOptions = {}) {
    this.bridgeEntryPath =
      options.bridgeEntryPath ?? join(__dirname, "mcp-connection-bridge.js");
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
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
    this.launchPollAttempts = options.launchPollAttempts ?? 16;
    this.launchPollDelayMs = options.launchPollDelayMs ?? 500;
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

  async listConnections(): Promise<McpConnectionStatus[]> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<McpConnectionStatus[]>(
        ownership.holder,
        "broker/list",
      );
    }
    return await Promise.all(
      this.registry.list().map(async (connection) =>
        await this.connectionStatus(connection),
      ),
    );
  }

  async createConnection(
    request: CreateMcpConnectionRequest,
  ): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/create",
        request,
      );
    }
    const connection = this.registry.create(request);
    return await this.connectionStatus(connection);
  }

  async authorizeConnection(connectionId: string): Promise<McpConnectionStatus> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/authorize",
        { connectionId },
      );
    }
    const connection = this.requireConnection(connectionId);
    await this.closeConnectionSessions(connectionId);
    const authorizationState = randomBytes(24).toString("base64url");
    const callback = await this.createOAuthCallback(
      authorizationState,
      connection.displayName,
      connection.id,
    );
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
      callback.complete(
        "connected",
        `PwrAgent can now offer ${connection.displayName} to the agents and threads you choose.`,
      );
      return await this.connectionStatus(connection);
    } catch (cause) {
      callback.complete(
        "failed",
        cause instanceof Error
          ? cause.message
          : "The secure connection could not be completed.",
      );
      throw cause;
    } finally {
      await callback.close();
    }
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
      return await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/update",
        request,
      );
    }
    const existing = this.requireConnection(request.connectionId);
    const { connection, serverUrlChanged } = this.registry.update({
      connectionId: request.connectionId,
      displayName: request.displayName,
      serverUrl: request.serverUrl,
    });
    if (serverUrlChanged) {
      await this.closeConnectionSessions(request.connectionId);
      await this.coordinatorFor(existing).disconnect();
      this.coordinators.delete(request.connectionId);
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
    // Through the same guard every other outbound path here uses. The probe
    // takes its URL from the renderer or from an agent tool, so it is the
    // one call in this file reachable with a wholly attacker-chosen host --
    // exactly what `createMcpSafeFetch` exists to refuse. `allowLoopback` is
    // false because only the built-in PwrSuite connections are local, and
    // those are never probed.
    return await probeMcpConnectionUrl(
      request.serverUrl,
      createMcpSafeFetch({ allowLoopback: false, fetchFn: this.fetchFn }),
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
      return await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/disconnect",
        { connectionId },
      );
    }
    const connection = this.requireConnection(connectionId);
    await this.closeConnectionSessions(connectionId);
    await this.coordinatorFor(connection).disconnect();
    if (connection.id === PWRSNAP_MCP_CONNECTION_ID) {
      this.sessionRevoked = false;
      await this.settings.clearPwrSnapMcpCredential();
    }
    return await this.connectionStatus(connection);
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
      return await this.requestOwnerBroker<McpConnectionStatus>(
        ownership.holder,
        "broker/set-enabled",
        { connectionId, enabled },
      );
    }
    this.requireConnection(connectionId);
    const connection = this.registry.setEnabled(connectionId, enabled);
    if (!enabled) {
      await this.closeConnectionSessions(connectionId);
    }
    return await this.connectionStatus(connection);
  }

  async removeConnection(connectionId: string): Promise<boolean> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.requestOwnerBroker<boolean>(
        ownership.holder,
        "broker/remove",
        { connectionId },
      );
    }
    if (connectionId === PWRSNAP_MCP_CONNECTION_ID || connectionId === PWRGIT_MCP_CONNECTION_ID) {
      throw new Error("Built-in MCP connections cannot be removed.");
    }
    this.requireConnection(connectionId);
    await this.closeConnectionSessions(connectionId);
    await this.coordinatorFor(this.requireConnection(connectionId)).disconnect();
    this.coordinators.delete(connectionId);
    return this.registry.remove(connectionId);
  }

  async registerBridge(
    connectionId: string,
    threadId?: string,
  ): Promise<McpConnectionBridgeRegistration> {
    const ownership = await this.ensureOwnerBroker();
    if (!ownership.owned) {
      return await this.registerOwnerBridge(
        ownership.holder,
        connectionId,
        threadId,
      );
    }
    // Availability is checked before credentials: a connection withheld by
    // the gateway switch or by its own switch is not an authorization
    // problem, and telling the operator to reauthorize would send them to
    // the wrong control.
    const connection = this.requireAvailableConnection(connectionId);
    const configured = await this.coordinatorFor(connection).configured();
    if (
      !configured
      && !(connection.id === PWRSNAP_MCP_CONNECTION_ID && this.sessionRevoked)
    ) {
      throw new Error(
        `${connection.displayName} is not connected to PwrAgent. Reauthorize it in Settings → Plugins.`,
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
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, { connectionId });
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
    await Promise.all(
      [...this.upstreamSessions.keys()].map(async (token) =>
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
    if (this.nonOwnerHolder) {
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
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = connect(record.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      const timeout = setTimeout(
        () => finish(new Error("The MCP connection owner did not respond.")),
        MCP_CONNECTION_TOOL_TIMEOUT_MS,
      );
      timeout.unref();
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
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        finish(new Error("The MCP connection owner closed unexpectedly."));
      });
    });
  }

  private async registerOwnerBridge(
    holder: RuntimeLeaseHolder,
    connectionId: string,
    threadId?: string,
  ): Promise<McpConnectionBridgeRegistration> {
    let record: McpConnectionBrokerRecord;
    let result: { token: string };
    try {
      record = this.readOwnerBrokerRecord(holder);
      result = await this.requestBrokerRecord<{ token: string }>(
        record,
        "broker/register",
        { connectionId, threadId },
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
      if (this.findInstalledPath()) {
        await this.openApplication();
        for (let attempt = 0; attempt < this.launchPollAttempts; attempt += 1) {
          await delay(this.launchPollDelayMs);
          if (await this.isEndpointAvailable()) break;
        }
      }
      if (!(await this.isEndpointAvailable())) {
        return {
          outcome: "needs_local_agent_access",
          status: await this.readStatus(),
        };
      }
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
    close: () => Promise<void>;
  }> {
    let resolveRequest: ((url: URL) => void) | undefined;
    let rejectRequest: ((error: Error) => void) | undefined;
    const requestPromise = new Promise<URL>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
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
      throw new Error(
        "The PwrAgent MCP gateway is turned off. Turn it on in Settings → Plugins to use managed connections.",
      );
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
    let coordinator = this.coordinators.get(connection.id);
    if (!coordinator) {
      const serverUrl = new URL(connection.serverUrl);
      const allowLoopback = serverUrl.hostname === "127.0.0.1"
        || serverUrl.hostname === "localhost"
        || serverUrl.hostname === "[::1]";
      coordinator = new McpOAuthSessionCoordinator({
        connectionId: connection.id,
        serverUrl,
        ...(connection.kind === "pwrsnap" ? { scope: PWRSNAP_SCOPES } : {}),
        ...(connection.kind === "pwrgit" ? {
          scope: "repository.roots.read repository.checkout.locate repository.metadata.read forge.status.read status.subscribe",
          discardRejectedCredentials: true,
          onCredentialRejected: async () => await this.settings.clearPwrGitMcpCredential(),
        } : {}),
        vault: this.credentialVault,
        fetchFn: createMcpSafeFetch({
          allowLoopback,
          fetchFn: this.fetchFn,
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
        onStateChange: (state, detail) => {
          connectionLog.info("MCP connection state changed", {
            connectionId: connection.id,
            state,
            ...(detail ? { detail } : {}),
          });
        },
      });
      this.coordinators.set(connection.id, coordinator);
    }
    return coordinator;
  }

  private async connectionStatus(
    connection: McpConnectionRecord,
  ): Promise<McpConnectionStatus> {
    const coordinator = this.coordinatorFor(connection);
    const configured = await coordinator.configured();
    return {
      ...connection,
      configured,
      state: configured ? coordinator.state : "disconnected",
      ...(coordinator.detail ? { detail: coordinator.detail } : {}),
    };
  }

  private async ensureUpstreamClient(
    token: string,
    grant: BridgeGrant,
  ): Promise<Client> {
    // Availability is checked before the cache, not after. A session opened
    // while the gateway was on would otherwise keep serving every later call
    // on this token: Codex re-registers each turn and would be refused, but
    // an ACP agent resolves its servers only at session create or load, so
    // nothing would ever notice the switch.
    const connection = this.requireAvailableConnection(grant.connectionId);
    const existing = this.upstreamSessions.get(token);
    if (existing) return existing.client;
    const pending = this.upstreamStarts.get(token);
    if (pending) return await pending;
    const start = this.openUpstreamSession(token, connection).finally(() => {
      this.upstreamStarts.delete(token);
    });
    this.upstreamStarts.set(token, start);
    return await start;
  }

  private async openUpstreamSession(
    token: string,
    connection: McpConnectionRecord,
  ): Promise<Client> {
    const coordinator = this.coordinatorFor(connection);
    if (!(await coordinator.configured())) {
      throw new Error(
        connection.id === PWRSNAP_MCP_CONNECTION_ID && this.sessionRevoked
          ? PWRSNAP_SESSION_REVOKED_ERROR
          : `${connection.displayName} needs to be reauthorized in Settings → Plugins.`,
      );
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.serverUrl),
      { fetch: coordinator.authorizedFetch() },
    );
    const client = new Client(
      {
        name: `pwragent-${connection.id}-proxy`,
        version: "1.0.0",
      },
      { capabilities: {} },
    );
    // A session evicts itself when it actually dies. Leaving that to the
    // per-request error path would close a healthy session shared by every
    // in-flight request on this token the first time one of them was
    // cancelled or answered with an ordinary JSON-RPC error.
    client.onclose = () => {
      if (this.upstreamSessions.get(token)?.client === client) {
        this.upstreamSessions.delete(token);
      }
    };
    try {
      await client.connect(transport);
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
    }
    this.upstreamSessions.set(token, { client, transport });
    return client;
  }

  private async closeUpstreamSession(token: string): Promise<void> {
    const session = this.upstreamSessions.get(token);
    this.upstreamSessions.delete(token);
    if (!session) return;
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
    await Promise.all(
      [...this.upstreamSessions.keys()].map(
        async (token) => await this.closeUpstreamSession(token),
      ),
    );
  }

  private async closeConnectionSessions(connectionId: string): Promise<void> {
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
    server.maxConnections = MAX_RPC_CONNECTIONS;
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
    const abortController = new AbortController();
    socket.once("close", () => abortController.abort());
    try {
      const result = await this.dispatchBridgeOperation(
        request.token,
        grant,
        request.op,
        request.params,
        abortController.signal,
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
      });
      this.respond(socket, { ok: false, error: message });
    }
  }

  private async dispatchBrokerOperation(
    operation: unknown,
    params: unknown,
  ): Promise<unknown> {
    const values = params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
    if (operation === "broker/list") {
      return await this.listConnections();
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
        || typeof values.serverUrl !== "string"
      ) {
        throw new Error("Invalid MCP connection create request.");
      }
      return await this.createConnection({
        displayName: values.displayName,
        serverUrl: values.serverUrl,
      });
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
      });
    }
    if (operation === "broker/probe") {
      if (typeof values.serverUrl !== "string") {
        throw new Error("Invalid MCP connection probe request.");
      }
      return await this.probeConnection({ serverUrl: values.serverUrl });
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
      || operation === "broker/disconnect"
      || operation === "broker/remove"
    ) {
      if (typeof values.connectionId !== "string") {
        throw new Error("Invalid MCP connection request.");
      }
      if (operation === "broker/authorize") {
        return await this.authorizeConnection(values.connectionId);
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
      if (!(await this.coordinatorFor(connection).configured())) {
        throw new Error(
          `${connection.displayName} is not connected to PwrAgent. Reauthorize it in Settings → Plugins.`,
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

  private async dispatchBridgeOperation(
    token: string,
    grant: BridgeGrant,
    operation: unknown,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = await this.ensureUpstreamClient(token, grant);
    const values = params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
    switch (operation) {
      case "describe": {
        const capabilities = client.getServerCapabilities();
        return {
          tools: Boolean(capabilities?.tools),
          resources: Boolean(capabilities?.resources),
          prompts: Boolean(capabilities?.prompts),
        };
      }
      case "tools/list":
        return await client.listTools(values);
      case "tools/call":
        return await client.callTool(
          values as Parameters<Client["callTool"]>[0],
          undefined,
          {
            ...(signal ? { signal } : {}),
            timeout: MCP_CONNECTION_TOOL_TIMEOUT_MS,
          },
        );
      case "resources/list":
        return await client.listResources(values);
      case "resources/templates/list":
        return await client.listResourceTemplates(values);
      case "resources/read":
        return await client.readResource(
          values as Parameters<Client["readResource"]>[0],
        );
      case "prompts/list":
        return await client.listPrompts(values);
      case "prompts/get":
        return await client.getPrompt(
          values as Parameters<Client["getPrompt"]>[0],
        );
      default:
        throw new Error("unsupported MCP operation");
    }
  }

  private respond(socket: Socket, response: BridgeResponse): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }
}

function secureTokenEqual(candidate: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

let mcpConnectionGatewayService: McpConnectionGatewayService | undefined;

export function getMcpConnectionGatewayService(): McpConnectionGatewayService {
  mcpConnectionGatewayService ??= new McpConnectionGatewayService();
  return mcpConnectionGatewayService;
}

export async function resetMcpConnectionGatewayServiceForTests(): Promise<void> {
  await mcpConnectionGatewayService?.close();
  mcpConnectionGatewayService = undefined;
}
