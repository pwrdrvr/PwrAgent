import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
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
  PWRSNAP_MCP_CONNECTION_ID,
  type ConnectPwrSnapResponse,
  type OpenPwrSnapResponse,
  type PwrSnapConnectionStatus,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";

const connectionLog = getMainLogger("pwragent:mcp-connections");
const PWRSNAP_MCP_URL = new URL("http://127.0.0.1:51729/mcp");
const PWRSNAP_DOWNLOAD_URL =
  "https://github.com/pwrdrvr/PwrSnap/releases/latest";
const PWRSNAP_SCOPES = [
  "library.read",
  "capture.composite.read",
  "capture.export",
  "capture.edit",
].join(" ");
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MCP_RPC_TIMEOUT_MS = 60_000;
const MAX_RPC_LINE_BYTES = 1024 * 1024;
const MAX_RPC_CONNECTIONS = 32;

type PwrSnapCredential = {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
};

type BridgeGrant = {
  connectionId: typeof PWRSNAP_MCP_CONNECTION_ID;
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

type PwrSnapSettings = Pick<
  ReturnType<typeof getDesktopSettingsService>,
  | "clearPwrSnapMcpCredential"
  | "resolvePwrSnapMcpCredential"
  | "savePwrSnapMcpCredential"
>;

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PwrSnapConnectionServiceOptions = {
  bridgeEntryPath?: string;
  fetchFn?: FetchLike;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  launchPollAttempts?: number;
  launchPollDelayMs?: number;
  resolveInstallPaths?: () => string[];
  settings?: PwrSnapSettings;
};

class StoredOAuthProvider implements OAuthClientProvider {
  private credential: PwrSnapCredential;

  constructor(
    private readonly callbackUrl: URL,
    credential: PwrSnapCredential,
    private readonly authorizationState: string,
    private readonly onRedirect: (url: URL) => Promise<void>,
    private readonly persistCredential: (
      credential: PwrSnapCredential,
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
      throw new Error("PwrSnap OAuth code verifier is unavailable.");
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

  snapshot(): PwrSnapCredential {
    return { ...this.credential };
  }

  private async persistIfAuthorized(): Promise<void> {
    if (this.credential.tokens?.access_token) {
      await this.persistCredential(this.snapshot());
    }
  }
}

function parseCredential(value: string | undefined): PwrSnapCredential {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as PwrSnapCredential;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

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

function htmlResponse(title: string, detail: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body><h1>${safeTitle}</h1><p>${escapeHtml(detail)}</p><p>You can close this window.</p></body></html>`;
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

export class PwrSnapConnectionService {
  private readonly bridgeEntryPath: string;
  private readonly fetchFn: FetchLike;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly openPath: (path: string) => Promise<string>;
  private readonly resolveInstallPaths: () => string[];
  private readonly settings: PwrSnapSettings;
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
  private connectPromise?: Promise<ConnectPwrSnapResponse>;

  constructor(options: PwrSnapConnectionServiceOptions = {}) {
    this.bridgeEntryPath =
      options.bridgeEntryPath ?? join(__dirname, "mcp-connection-bridge.js");
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
    this.openPath = options.openPath ?? ((path) => shell.openPath(path));
    this.resolveInstallPaths =
      options.resolveInstallPaths ?? resolveDefaultPwrSnapInstallPaths;
    this.settings = options.settings ?? getDesktopSettingsService();
    this.launchPollAttempts = options.launchPollAttempts ?? 16;
    this.launchPollDelayMs = options.launchPollDelayMs ?? 500;
  }

  async readStatus(): Promise<PwrSnapConnectionStatus> {
    const [credential, endpointAvailable] = await Promise.all([
      this.readCredential(),
      this.isEndpointAvailable(),
    ]);
    const installed = endpointAvailable || Boolean(this.findInstalledPath());
    return {
      connectionId: PWRSNAP_MCP_CONNECTION_ID,
      displayName: "PwrSnap",
      availability: endpointAvailable
        ? "running"
        : installed
          ? "installed"
          : "not_installed",
      configured: Boolean(credential.tokens?.access_token),
      ...(!endpointAvailable && installed
        ? {
            detail:
              "Open PwrSnap and enable Local Agent Access to connect agents.",
          }
        : {}),
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
    if (connectionId !== PWRSNAP_MCP_CONNECTION_ID) {
      throw new Error(`Unknown MCP connection: ${connectionId}`);
    }
    const credential = await this.readCredential();
    if (!credential.tokens?.access_token) {
      throw new Error("PwrSnap is not connected to PwrAgent.");
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
    this.grants.set(token, { connectionId: PWRSNAP_MCP_CONNECTION_ID });
    const socketPath = this.bridgeSocketPath;
    if (!socketPath) {
      this.grants.delete(token);
      throw new Error("The PwrAgent MCP bridge is unavailable.");
    }
    const server = {
      name: PWRSNAP_MCP_CONNECTION_ID,
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
        serverUrl: PWRSNAP_MCP_URL,
        scope: PWRSNAP_SCOPES,
        fetchFn: this.fetchFn,
      });
      if (initial !== "REDIRECT") {
        throw new Error("PwrSnap authorization did not open a consent request.");
      }
      const authorizationCode = await callback.waitForCode();
      const completed = await auth(provider, {
        serverUrl: PWRSNAP_MCP_URL,
        authorizationCode,
        scope: PWRSNAP_SCOPES,
        fetchFn: this.fetchFn,
      });
      if (completed !== "AUTHORIZED") {
        throw new Error("PwrSnap authorization did not complete.");
      }
      await this.persistCredential(provider.snapshot());
      await this.ensureUpstreamClient();
      return { outcome: "connected", status: await this.readStatus() };
    } finally {
      await callback.close();
    }
  }

  private async createOAuthCallback(expectedState: string): Promise<{
    url: URL;
    waitForCode: () => Promise<string>;
    close: () => Promise<void>;
  }> {
    let resolveRequest: ((url: URL) => void) | undefined;
    let rejectRequest: ((error: Error) => void) | undefined;
    const requestPromise = new Promise<URL>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const server: HttpServer = createHttpServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
      if (requestUrl.pathname !== "/oauth/callback") {
        response.writeHead(404).end();
        return;
      }
      const error = requestUrl.searchParams.get("error");
      if (error) {
        const detail =
          requestUrl.searchParams.get("error_description") ?? error;
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(htmlResponse("PwrSnap connection declined", detail));
        rejectRequest?.(new Error(detail));
        return;
      }
      if (requestUrl.searchParams.get("state") !== expectedState) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(
          htmlResponse(
            "PwrSnap connection rejected",
            "The authorization state did not match.",
          ),
        );
        rejectRequest?.(new Error("PwrSnap authorization state did not match."));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        htmlResponse(
          "PwrSnap connected",
          "PwrAgent can now offer PwrSnap to the agents you choose.",
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
      throw new Error("Could not start the PwrSnap OAuth callback.");
    }
    return {
      url: new URL(`http://127.0.0.1:${address.port}/oauth/callback`),
      waitForCode: async () => {
        const timeout = setTimeout(() => {
          rejectRequest?.(new Error("PwrSnap authorization timed out."));
        }, OAUTH_CALLBACK_TIMEOUT_MS);
        try {
          const requestUrl = await requestPromise;
          const code = requestUrl.searchParams.get("code");
          if (!code) throw new Error("PwrSnap did not return an authorization code.");
          return code;
        } finally {
          clearTimeout(timeout);
        }
      },
      close: async () =>
        await new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  private async isEndpointAvailable(): Promise<boolean> {
    try {
      await this.fetchFn(PWRSNAP_MCP_URL, {
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      });
      return true;
    } catch {
      return false;
    }
  }

  private findInstalledPath(): string | undefined {
    return this.resolveInstallPaths().find((candidate) => existsSync(candidate));
  }

  private async readCredential(): Promise<PwrSnapCredential> {
    return parseCredential(await this.settings.resolvePwrSnapMcpCredential());
  }

  private async persistCredential(
    credential: PwrSnapCredential,
  ): Promise<void> {
    if (!credential.tokens?.access_token) {
      await this.settings.clearPwrSnapMcpCredential();
      return;
    }
    await this.settings.savePwrSnapMcpCredential(JSON.stringify(credential));
  }

  private async ensureUpstreamClient(): Promise<Client> {
    if (this.upstreamClient) return this.upstreamClient;
    const credential = await this.readCredential();
    if (!credential.tokens?.access_token) {
      throw new Error("PwrSnap is not connected to PwrAgent.");
    }
    const provider = new StoredOAuthProvider(
      new URL("http://127.0.0.1/oauth/callback"),
      credential,
      randomBytes(24).toString("base64url"),
      async () => {
        throw new Error("PwrSnap needs to be reconnected from New Thread.");
      },
      async (next) => await this.persistCredential(next),
    );
    const transport = new StreamableHTTPClientTransport(PWRSNAP_MCP_URL, {
      authProvider: provider,
      fetch: this.fetchFn,
    });
    const client = new Client(
      { name: "pwragent-pwrsnap-proxy", version: "1.0.0" },
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
    socket.setTimeout(30_000, () => socket.destroy());
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
          tools: Boolean(capabilities?.tools),
          resources: Boolean(capabilities?.resources),
          prompts: Boolean(capabilities?.prompts),
        };
      }
      case "tools/list":
        return await client.listTools(values);
      case "tools/call":
        return await client.callTool(values as Parameters<Client["callTool"]>[0]);
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

let pwrSnapConnectionService: PwrSnapConnectionService | undefined;

export function getPwrSnapConnectionService(): PwrSnapConnectionService {
  pwrSnapConnectionService ??= new PwrSnapConnectionService();
  return pwrSnapConnectionService;
}

export async function resetPwrSnapConnectionServiceForTests(): Promise<void> {
  await pwrSnapConnectionService?.close();
  pwrSnapConnectionService = undefined;
}
