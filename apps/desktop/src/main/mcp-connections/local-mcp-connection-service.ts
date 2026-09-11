import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { shell } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  PWRSNAP_SESSION_REVOKED_DETAIL,
  type OpenPwrSnapResponse,
  type PwrSnapConnectionStatus,
  type PwrGitConnectionStatus,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { MCP_CONNECTION_TOOL_TIMEOUT_MS } from "./mcp-connection-timeouts";

const connectionLog = getMainLogger("pwragent:mcp-connections");

const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_RPC_LINE_BYTES = 1024 * 1024;
const MAX_RPC_CONNECTIONS = 32;

type LocalMcpCredential = {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
};

type BridgeGrant = {
  connectionId: "pwrsnap" | "pwrgit";
  threadId?: string;
};

type BridgeRequest = {
  token?: unknown;
  op?: unknown;
  params?: unknown;
};

type BridgeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

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

type ConnectionStatus = { pwrsnap: PwrSnapConnectionStatus; pwrgit: PwrGitConnectionStatus };
type ConnectionId = keyof ConnectionStatus;
type ConnectionSettings = {
  clearCredential: () => Promise<void>;
  resolveCredential: () => Promise<string | undefined>;
  saveCredential: (value: string) => Promise<void>;
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LocalMcpConnectionServiceOptions<Id extends ConnectionId> = {
  connectionId: Id;
  displayName: ConnectionStatus[Id]["displayName"];
  endpoint: URL;
  scopes: string;
  downloadUrl: string;
  verifyResourceMetadata?: boolean;
  bridgeEntryPath?: string;
  fetchFn?: FetchLike;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  launchPollAttempts?: number;
  launchPollDelayMs?: number;
  resolveInstallPaths?: () => string[];
  settings: ConnectionSettings;
};

class StoredOAuthProvider implements OAuthClientProvider {
  private credential: LocalMcpCredential;

  constructor(
    private readonly callbackUrl: URL,
    credential: LocalMcpCredential,
    private readonly authorizationState: string,
    private readonly onRedirect: (url: URL) => Promise<void>,
    private readonly persistCredential: (
      credential: LocalMcpCredential,
    ) => Promise<void>,
  ) {
    this.credential = { ...credential };
  }

  get redirectUrl(): URL {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "PwrAgent",
      redirect_uris: [this.callbackUrl.href],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.authorizationState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.credential.clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    this.credential.clientInformation = clientInformation;
    await this.persistIfAuthorized();
  }

  tokens(): OAuthTokens | undefined {
    return this.credential.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.credential.tokens = tokens;
    await this.persistCredential(this.snapshot());
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.credential.codeVerifier = codeVerifier;
    await this.persistIfAuthorized();
  }

  codeVerifier(): string {
    if (!this.credential.codeVerifier) {
      throw new Error("MCP OAuth code verifier is unavailable.");
    }
    return this.credential.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.credential.discoveryState = state;
    await this.persistIfAuthorized();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.credential.discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "client") {
      delete this.credential.clientInformation;
    }
    if (scope === "all" || scope === "tokens") {
      delete this.credential.tokens;
    }
    if (scope === "all" || scope === "verifier") {
      delete this.credential.codeVerifier;
    }
    if (scope === "all" || scope === "discovery") {
      delete this.credential.discoveryState;
    }
    await this.persistCredential(this.snapshot());
  }

  snapshot(): LocalMcpCredential {
    return { ...this.credential };
  }

  private async persistIfAuthorized(): Promise<void> {
    if (this.credential.tokens?.access_token) {
      await this.persistCredential(this.snapshot());
    }
  }
}

function parseCredential(value: string | undefined): LocalMcpCredential {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as LocalMcpCredential;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The page the browser lands on after the sister app's authorization screen.
 * Exported for `oauth-callback-page.test.ts`: it is the only part of this
 * service a person ever looks at, and nothing else here renders markup.
 */
export function htmlResponse(
  title: string,
  detail: string,
  options: { liveStatus?: boolean } = {},
  connectionId: ConnectionId = "pwrsnap",
): string {
  const displayName = connectionId === "pwrgit" ? "PwrGit" : "PwrSnap";
  const safeTitle = escapeHtml(title);
  const liveStatus = options.liveStatus === true;
  // PwrGit's brand asset is the only one of the three that carries Apple's
  // legacy margin; see `.app-mark--inset-plate` below.
  const insetPlate = connectionId === "pwrgit";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${safeTitle}</title>
  <!-- PwrAgent's own mark, not the sister app's: this window belongs to
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
    .app-icon { display: grid; place-items: center; width: 104px; height: 104px; padding: 4px; border: 1px solid #2b2926; border-radius: 27px; background: #141312; box-shadow: 0 20px 55px rgba(0, 0, 0, .45); }
    .app-mark { width: 100%; height: 100%; object-fit: contain; }
    /* Each mark is its own app's icon, copied verbatim, and they were authored
       on different canvases: most plates fill theirs, while the one flagged
       here sits on Apple's legacy 824-in-1024 template, so a fifth of that
       canvas is transparent margin. Drawn into the same tile it paints at 80%
       of the mark beside it, which reads as a small icon lost inside an empty
       frame. Scale it back by the canvas over the plate it holds — the same
       ratio, and the same reason, as \`.mcp-connection__icon--inset-plate\` in
       the renderer's app.css. The tile is the parent, so only the artwork
       grows, and the only thing this paints outside the tile is the asset's
       own transparent margin. */
    .app-mark--inset-plate { transform: scale(calc(256 / 206)); }
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
    <p class="eyebrow">PwrSuite connection</p>
    <h1 id="title">${safeTitle}</h1>
    <p class="detail" id="detail">${escapeHtml(detail)}</p>
    <div class="connection" aria-label="PwrAgent connection to ${displayName}">
      <div class="app"><span class="app-icon"><img class="app-mark" src="/assets/pwragent.png" alt=""></span><span>PwrAgent</span></div>
      <div class="line" aria-hidden="true"><span class="signal"></span></div>
      <div class="app"><span class="app-icon"><img class="app-mark${insetPlate ? " app-mark--inset-plate" : ""}" src="/assets/${connectionId}.png" alt=""></span><span>${displayName}</span></div>
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
    const check = async () => {
      try {
        const response = await fetch("/oauth/status", { cache: "no-store" });
        const result = await response.json();
        if (result.state === "connected") {
          settle("is-connected", "PwrAgent is connected to ${displayName}", result.detail, "Secure connection ready");
          return;
        }
        if (result.state === "failed") {
          settle("is-failed", "Connection could not be completed", result.detail, "Connection stopped");
          return;
        }
      } catch {}
      setTimeout(check, 250);
    };
    void check();
  </script>` : ""}
</body>
</html>`;
}

function connectionAsset(name: "pwragent" | ConnectionId): Buffer | null {
  const fileName = `${name}-app-icon.png`;
  const sourceFile = name === "pwragent"
    ? "build/icon.png"
    : `src/renderer/src/assets/${name}/${name}-app-icon.png`;
  const candidates = [
    join(process.resourcesPath, fileName),
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

export class LocalMcpConnectionService<Id extends ConnectionId> {
  private readonly bridgeEntryPath: string;
  private readonly fetchFn: FetchLike;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly openPath: (path: string) => Promise<string>;
  private readonly resolveInstallPaths: () => string[];
  private readonly settings: ConnectionSettings;
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
  private upstreamClient?: Client;
  private upstreamTransport?: StreamableHTTPClientTransport;
  private connectPromise?: Promise<{ status: ConnectionStatus[Id]; outcome: "connected" | "needs_local_agent_access" }>;
  private sessionRevoked = false;

  constructor(private readonly options: LocalMcpConnectionServiceOptions<Id>) {
    this.bridgeEntryPath =
      options.bridgeEntryPath ?? join(__dirname, "mcp-connection-bridge.js");
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
    this.openPath = options.openPath ?? ((path) => shell.openPath(path));
    this.resolveInstallPaths =
      options.resolveInstallPaths ?? (() => []);
    this.settings = options.settings;
    this.launchPollAttempts = options.launchPollAttempts ?? 16;
    this.launchPollDelayMs = options.launchPollDelayMs ?? 500;
  }

  private htmlResponse(title: string, detail: string, options: { liveStatus?: boolean } = {}): string {
    return htmlResponse(title, detail, options, this.options.connectionId);
  }

  private revokedDetail(): string {
    return PWRSNAP_SESSION_REVOKED_DETAIL.replaceAll("PwrSnap", this.options.displayName);
  }

  private revokedError(): string {
    return `${this.options.displayName} revoked this connection. ${this.options.displayName} tools stay unavailable until the operator chooses Connect to ${this.options.displayName} in PwrAgent.`;
  }

  async readStatus(): Promise<ConnectionStatus[Id]> {
    const [credential, endpointAvailable] = await Promise.all([
      this.readCredential(),
      this.isEndpointAvailable(),
    ]);
    const installed = endpointAvailable || Boolean(this.findInstalledPath());
    const configured = Boolean(credential.tokens?.access_token);
    const details: string[] = [];
    if (!configured && this.sessionRevoked) {
      details.push(this.revokedDetail());
    }
    if (!endpointAvailable && installed) {
      details.push(`PwrAgent cannot reach ${this.options.displayName}’s local MCP endpoint. Open ${this.options.displayName}, check Local Agent Access, and retry. A running app may need an update or restart.`);
    }
    const detail = details.join(" ");
    return {
      connectionId: this.options.connectionId,
      displayName: this.options.displayName,
      availability: endpointAvailable
        ? "running"
        : installed
          ? "installed"
          : "not_installed",
      configured,
      ...(detail ? { detail } : {}),
    } as ConnectionStatus[Id];
  }

  async openDownload(): Promise<OpenPwrSnapResponse> {
    try {
      await this.openExternal(this.options.downloadUrl);
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
      return { opened: false, error: `${this.options.displayName} is not installed.` };
    }
    const error = await this.openPath(installedPath);
    return error ? { opened: false, error } : { opened: true };
  }

  async connect(): Promise<{ status: ConnectionStatus[Id]; outcome: "connected" | "needs_local_agent_access" }> {
    if (!this.connectPromise) {
      this.connectPromise = this.connectNow().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return await this.connectPromise;
  }

  async registerBridge(
    connectionId: string,
    threadId?: string,
  ): Promise<McpConnectionBridgeRegistration> {
    if (connectionId !== this.options.connectionId) {
      throw new Error(`Unknown MCP connection: ${connectionId}`);
    }
    // No credential check here: a thread with this connection must keep
    // starting turns after the app revokes the session. Each proxied call
    // reports the revoke to the agent instead, through ensureUpstreamClient.
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
    this.grants.set(token, { connectionId: this.options.connectionId });
    const socketPath = this.bridgeSocketPath;
    if (!socketPath) {
      this.grants.delete(token);
      throw new Error("The PwrAgent MCP bridge is unavailable.");
    }
    const server = {
      name: this.options.connectionId,
      command: process.execPath,
      args: [this.bridgeEntryPath],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PWRAGENT_MCP_CONNECTION_SOCKET: socketPath,
        PWRAGENT_MCP_CONNECTION_TOKEN: token,
      },
    } satisfies McpConnectionBridgeServer;
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
        if (currentRegistrationKey) {
          this.threadRegistrations.delete(currentRegistrationKey);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.grants.clear();
    this.threadRegistrations.clear();
    await this.closeUpstream();
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
  }

  private async connectNow(): Promise<{ status: ConnectionStatus[Id]; outcome: "connected" | "needs_local_agent_access" }> {
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

    await this.closeUpstream();
    const authorizationState = randomBytes(24).toString("base64url");
    const callback = await this.createOAuthCallback(authorizationState);
    const provider = new StoredOAuthProvider(
      callback.url,
      {},
      authorizationState,
      async (url) => await this.openExternal(url.href),
      async (credential) => await this.persistCredential(credential),
    );
    try {
      const initial = await auth(provider, {
        serverUrl: this.options.endpoint,
        scope: this.options.scopes,
        fetchFn: this.fetchFn,
      });
      if (initial !== "REDIRECT") {
        throw new Error(`${this.options.displayName} authorization did not open a consent request.`);
      }
      const authorizationCode = await callback.waitForCode();
      const completed = await auth(provider, {
        serverUrl: this.options.endpoint,
        authorizationCode,
        scope: this.options.scopes,
        fetchFn: this.fetchFn,
      });
      if (completed !== "AUTHORIZED") {
        throw new Error(`${this.options.displayName} authorization did not complete.`);
      }
      await this.persistCredential(provider.snapshot());
      await this.ensureUpstreamClient();
      callback.complete(
        "connected",
        `PwrAgent can now offer ${this.options.displayName} to the agents and threads you choose.`,
      );
      return { outcome: "connected", status: await this.readStatus() };
    } catch (cause) {
      callback.complete(
        "failed",
        cause instanceof Error ? cause.message : "The secure connection could not be completed.",
      );
      throw cause;
    } finally {
      await callback.close();
    }
  }

  private async createOAuthCallback(expectedState: string): Promise<{
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
      if (requestUrl.pathname === "/assets/pwragent.png" || requestUrl.pathname === `/assets/${this.options.connectionId}.png`) {
        const asset = connectionAsset(
          requestUrl.pathname.endsWith("pwragent.png") ? "pwragent" : this.options.connectionId,
        );
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
      const error = requestUrl.searchParams.get("error");
      if (error) {
        const detail =
          requestUrl.searchParams.get("error_description") ?? error;
        callbackState = { state: "failed", detail };
        response.writeHead(400, callbackHtmlHeaders());
        response.end(this.htmlResponse(`${this.options.displayName} connection declined`, detail));
        rejectRequest?.(new Error(detail));
        return;
      }
      if (requestUrl.searchParams.get("state") !== expectedState) {
        callbackState = {
          state: "failed",
          detail: "The authorization state did not match.",
        };
        response.writeHead(400, callbackHtmlHeaders());
        response.end(
          this.htmlResponse(
            `${this.options.displayName} connection rejected`,
            "The authorization state did not match.",
          ),
        );
        rejectRequest?.(new Error(`${this.options.displayName} authorization state did not match.`));
        return;
      }
      response.writeHead(200, callbackHtmlHeaders());
      response.end(
        this.htmlResponse(
          `Connecting PwrAgent to ${this.options.displayName}`,
          `${this.options.displayName} approved the request. PwrAgent is finishing the secure local connection.`,
          { liveStatus: true },
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
      throw new Error(`Could not start the ${this.options.displayName} OAuth callback.`);
    }
    return {
      url: new URL(`http://127.0.0.1:${address.port}/oauth/callback`),
      waitForCode: async () => {
        const timeout = setTimeout(() => {
          rejectRequest?.(new Error(`${this.options.displayName} authorization timed out.`));
        }, OAUTH_CALLBACK_TIMEOUT_MS);
        try {
          const requestUrl = await requestPromise;
          const code = requestUrl.searchParams.get("code");
          if (!code) throw new Error(`${this.options.displayName} did not return an authorization code.`);
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
      const response = await this.fetchFn(this.options.endpoint, {
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      });
      if (!(response.ok || response.status === 401 || response.status === 405)) return false;
      if (this.options.verifyResourceMetadata) {
        const metadataResponse = await this.fetchFn(
          new URL("/.well-known/oauth-protected-resource/mcp", this.options.endpoint),
          { signal: AbortSignal.timeout(1_000) },
        );
        if (!metadataResponse.ok) return false;
        const metadata = await metadataResponse.json() as { resource?: unknown; resource_name?: unknown };
        return metadata?.resource === this.options.endpoint.href
          && metadata.resource_name === this.options.displayName;
      }
      return true;
    } catch {
      return false;
    }
  }

  private findInstalledPath(): string | undefined {
    return this.resolveInstallPaths().find((candidate) => existsSync(candidate));
  }

  private async readCredential(): Promise<LocalMcpCredential> {
    return parseCredential(await this.settings.resolveCredential());
  }

  private async persistCredential(
    credential: LocalMcpCredential,
  ): Promise<void> {
    if (!credential.tokens?.access_token) {
      await this.settings.clearCredential();
      return;
    }
    this.sessionRevoked = false;
    await this.settings.saveCredential(JSON.stringify(credential));
  }

  /**
   * PwrSnap rejected `rejectedAccessToken`, so drop it: readStatus() then
   * reports configured: false and New thread offers Connect to PwrSnap again.
   * A concurrent Connect may already have stored a fresh token, and a
   * concurrent proxied call may already have cleared this one; neither
   * case writes.
   */
  private async revokeStoredSession(rejectedAccessToken: string): Promise<void> {
    const storedAccessToken = (await this.readCredential()).tokens?.access_token;
    if (storedAccessToken && storedAccessToken !== rejectedAccessToken) return;
    this.sessionRevoked = true;
    if (!storedAccessToken) return;
    connectionLog.warn(`${this.options.displayName} rejected the stored session; clearing credential`);
    await this.settings.clearCredential();
  }

  private async ensureUpstreamClient(): Promise<Client> {
    if (this.upstreamClient) return this.upstreamClient;
    const credential = await this.readCredential();
    const accessToken = credential.tokens?.access_token;
    if (!accessToken) {
      throw new Error(
        this.sessionRevoked
          ? this.revokedError()
          : `${this.options.displayName} is not connected to PwrAgent.`,
      );
    }
    const provider = new StoredOAuthProvider(
      new URL("http://127.0.0.1/oauth/callback"),
      credential,
      randomBytes(24).toString("base64url"),
      async () => {
        // The SDK only starts a new authorization after PwrSnap answered 401
        // and no refresh token could rescue the session. The proxy cannot
        // open a consent window, so treat this as a revoked session.
        await this.revokeStoredSession(accessToken);
        throw new Error(this.revokedError());
      },
      async (next) => {
        // The SDK saves a code verifier for the authorization it is about to
        // start, while the snapshot still carries the rejected token. Do not
        // write that back: only a token change is worth persisting here.
        if (next.tokens?.access_token === accessToken) return;
        await this.persistCredential(next);
      },
    );
    const transport = new StreamableHTTPClientTransport(this.options.endpoint, {
      authProvider: provider,
      fetch: this.fetchFn,
    });
    const client = new Client(
      { name: `pwragent-${this.options.connectionId}-proxy`, version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    this.upstreamClient = client;
    this.upstreamTransport = transport;
    return client;
  }

  private async closeUpstream(): Promise<void> {
    const client = this.upstreamClient;
    const transport = this.upstreamTransport;
    this.upstreamClient = undefined;
    this.upstreamTransport = undefined;
    if (client) {
      await client.close().catch(() => undefined);
    } else if (transport) {
      await transport.close().catch(() => undefined);
    }
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
    if (typeof request.token !== "string" || !this.grants.has(request.token)) {
      this.respond(socket, { ok: false, error: "unauthorized" });
      return;
    }
    try {
      const result = await this.dispatchBridgeOperation(request.op, request.params);
      this.respond(socket, { ok: true, result });
    } catch (error) {
      await this.closeUpstream();
      const message = error instanceof Error ? error.message : String(error);
      connectionLog.warn("proxied MCP operation failed", {
        message,
        operation: request.op,
      });
      this.respond(socket, { ok: false, error: message });
    }
  }

  private async dispatchBridgeOperation(
    operation: unknown,
    params: unknown,
  ): Promise<unknown> {
    const client = await this.ensureUpstreamClient();
    const values = params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
    switch (operation) {
      case "describe": {
        const capabilities = client.getServerCapabilities();
        return {
          name: this.options.connectionId,
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
          { timeout: MCP_CONNECTION_TOOL_TIMEOUT_MS },
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
