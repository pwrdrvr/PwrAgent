import { randomBytes } from "node:crypto";
import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConnectionRuntimeState } from "@pwragent/shared";
import {
  McpCredentialVault,
  type McpOAuthCredential,
} from "./mcp-credential-vault";

export class McpReauthorizationRequiredError extends Error {
  constructor(message = "This MCP connection needs to be reauthorized.") {
    super(message);
    this.name = "McpReauthorizationRequiredError";
  }
}

export type McpOAuthSessionCoordinatorOptions = {
  connectionId: string;
  serverUrl: URL;
  scope?: string;
  vault?: McpCredentialVault;
  fetchFn?: FetchLike;
  authFn?: typeof auth;
  onStateChange?: (
    state: McpConnectionRuntimeState,
    detail?: string,
  ) => void;
};

type TokenSnapshot = {
  accessToken: string;
  generation: number;
};

export class McpOAuthSessionCoordinator {
  private readonly connectionId: string;
  private readonly serverUrl: URL;
  private readonly scope?: string;
  private readonly vault: McpCredentialVault;
  private readonly fetchFn: FetchLike;
  private readonly authFn: typeof auth;
  private readonly onStateChange?: McpOAuthSessionCoordinatorOptions["onStateChange"];
  private credential?: McpOAuthCredential;
  private loaded = false;
  private generation = 0;
  private loadPromise?: Promise<void>;
  private refreshPromise?: Promise<void>;
  private runtimeState: McpConnectionRuntimeState = "disconnected";
  private runtimeDetail?: string;

  constructor(options: McpOAuthSessionCoordinatorOptions) {
    this.connectionId = options.connectionId;
    this.serverUrl = options.serverUrl;
    this.scope = options.scope;
    this.vault = options.vault ?? new McpCredentialVault();
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.authFn = options.authFn ?? auth;
    this.onStateChange = options.onStateChange;
  }

  get state(): McpConnectionRuntimeState {
    return this.runtimeState;
  }

  get detail(): string | undefined {
    return this.runtimeDetail;
  }

  async configured(): Promise<boolean> {
    await this.ensureLoaded();
    return Boolean(this.credential?.tokens?.access_token);
  }

  async authorize(params: {
    redirectUrl: URL;
    state?: string;
    onRedirect: (url: URL) => Promise<void>;
    waitForCode: () => Promise<string>;
  }): Promise<void> {
    await this.ensureLoaded();
    this.setState("connecting");
    const previous = this.credential;
    const redirectChanged =
      previous?.redirectUrl !== undefined
      && previous.redirectUrl !== params.redirectUrl.href;
    const working: McpOAuthCredential = {
      resourceUrl: this.serverUrl.href,
      ...(redirectChanged ? {} : {
        clientInformation: previous?.clientInformation,
      }),
      discoveryState: previous?.discoveryState,
      redirectUrl: params.redirectUrl.href,
    };
    if (!working.discoveryState) {
      try {
        const discovered = await discoverOAuthServerInfo(this.serverUrl, {
          fetchFn: this.fetchFn,
        });
        working.discoveryState = discovered;
      } catch (error) {
        const detail = errorMessage(error);
        this.setState("temporarily_unavailable", detail);
        throw new Error(detail, { cause: error });
      }
    }
    const authorizationScope = this.authorizationScope(working);
    const provider = new CoordinatedOAuthProvider({
      callbackUrl: params.redirectUrl,
      credential: working,
      authorizationState:
        params.state ?? randomBytes(24).toString("base64url"),
      onRedirect: params.onRedirect,
      onCommit: async (credential) => await this.commitCredential(credential),
      retainRefreshToken: false,
    });
    try {
      const initial = await this.authFn(provider, {
        serverUrl: this.serverUrl,
        scope: authorizationScope,
        fetchFn: this.fetchFn,
      });
      if (initial !== "REDIRECT") {
        throw new Error("The MCP authorization server did not request consent.");
      }
      const authorizationCode = await params.waitForCode();
      const completed = await this.authFn(provider, {
        serverUrl: this.serverUrl,
        authorizationCode,
        scope: authorizationScope,
        fetchFn: this.fetchFn,
      });
      if (completed !== "AUTHORIZED") {
        throw new Error("The MCP authorization did not complete.");
      }
      this.setState("ready");
    } catch (error) {
      const detail = errorMessage(error);
      this.setState("reauthorization_required", detail);
      throw new Error(detail, { cause: error });
    }
  }

  async disconnect(): Promise<void> {
    await this.vault.delete(this.connectionId);
    this.credential = undefined;
    this.loaded = true;
    this.generation += 1;
    this.setState("disconnected");
  }

  authorizedFetch(): FetchLike {
    return async (url, init) => {
      const initial = await this.tokenSnapshot();
      const response = await this.fetchProtectedResource(
        url,
        init,
        initial.accessToken,
      );
      if (response.status !== 401) return response;
      await response.body?.cancel().catch(() => undefined);
      await this.refresh(initial.generation);
      const refreshed = await this.tokenSnapshot();
      const retried = await this.fetchProtectedResource(
        url,
        init,
        refreshed.accessToken,
      );
      if (retried.status === 401) {
        await retried.body?.cancel().catch(() => undefined);
        this.setState(
          "reauthorization_required",
          "The refreshed MCP authorization was rejected.",
        );
        throw new McpReauthorizationRequiredError(
          "The refreshed MCP authorization was rejected. Reauthorize it in Settings.",
        );
      }
      return retried;
    };
  }

  private async tokenSnapshot(): Promise<TokenSnapshot> {
    await this.ensureLoaded();
    const accessToken = this.credential?.tokens?.access_token;
    if (!accessToken) {
      this.setState("reauthorization_required");
      throw new McpReauthorizationRequiredError();
    }
    return { accessToken, generation: this.generation };
  }

  private async refresh(expectedGeneration: number): Promise<void> {
    await this.ensureLoaded();
    if (this.generation !== expectedGeneration) return;
    if (this.refreshPromise) return await this.refreshPromise;
    this.refreshPromise = this.refreshNow(expectedGeneration).finally(() => {
      this.refreshPromise = undefined;
    });
    return await this.refreshPromise;
  }

  private async refreshNow(expectedGeneration: number): Promise<void> {
    if (this.generation !== expectedGeneration) return;
    const current = this.credential;
    if (!current?.tokens?.refresh_token) {
      this.setState("reauthorization_required");
      throw new McpReauthorizationRequiredError(
        "The MCP authorization did not include a refresh token.",
      );
    }
    this.setState("refreshing");
    const provider = new CoordinatedOAuthProvider({
      callbackUrl: new URL(
        current.redirectUrl ?? "http://127.0.0.1/oauth/callback",
      ),
      credential: current,
      authorizationState: randomBytes(24).toString("base64url"),
      onRedirect: async () => {
        throw new McpReauthorizationRequiredError();
      },
      onCommit: async (credential) => await this.commitCredential(credential),
      retainRefreshToken: true,
    });
    try {
      const result = await this.authFn(provider, {
        serverUrl: this.serverUrl,
        scope: this.scope,
        fetchFn: this.fetchFn,
      });
      if (result !== "AUTHORIZED") {
        throw new McpReauthorizationRequiredError();
      }
      this.setState("ready");
    } catch (error) {
      if (isAuthorizationFailure(error)) {
        const durable = await this.vault.read(
          this.connectionId,
          this.serverUrl.href,
        );
        if (
          durable?.tokens?.access_token
          && durable.tokens.access_token !== current.tokens?.access_token
        ) {
          this.credential = durable;
          this.generation += 1;
          this.setState("ready");
          return;
        }
        this.setState("reauthorization_required", errorMessage(error));
        throw new McpReauthorizationRequiredError(
          "The MCP authorization can no longer be refreshed. Reauthorize it in Settings.",
        );
      }
      this.setState("temporarily_unavailable", errorMessage(error));
      throw new Error(errorMessage(error), { cause: error });
    }
  }

  private async fetchWithToken(
    url: string | URL,
    init: RequestInit | undefined,
    accessToken: string,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    return await this.fetchFn(url, { ...init, headers });
  }

  private async fetchProtectedResource(
    url: string | URL,
    init: RequestInit | undefined,
    accessToken: string,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchWithToken(url, init, accessToken);
    } catch (error) {
      const detail = errorMessage(error);
      this.setState("temporarily_unavailable", detail);
      throw new Error(detail, { cause: error });
    }
    if (response.status === 429 || response.status >= 500) {
      this.setState(
        "temporarily_unavailable",
        `The MCP server returned HTTP ${response.status}.`,
      );
    } else if (
      response.status < 400
      && this.runtimeState === "temporarily_unavailable"
    ) {
      this.setState("ready");
    }
    return response;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadNow().finally(() => {
        this.loadPromise = undefined;
      });
    }
    await this.loadPromise;
  }

  private async loadNow(): Promise<void> {
    this.credential = await this.vault.read(
      this.connectionId,
      this.serverUrl.href,
    );
    this.loaded = true;
    this.generation += 1;
    this.setState(
      this.credential?.tokens?.access_token ? "ready" : "disconnected",
    );
  }

  private async commitCredential(
    credential: McpOAuthCredential,
  ): Promise<void> {
    await this.vault.write(this.connectionId, credential);
    this.credential = structuredClone(credential);
    this.generation += 1;
  }

  private authorizationScope(credential: McpOAuthCredential): string | undefined {
    if (this.scope) return this.scope;
    const resourceScopes =
      credential.discoveryState?.resourceMetadata?.scopes_supported ?? [];
    const authorizationScopes =
      credential.discoveryState?.authorizationServerMetadata?.scopes_supported
      ?? [];
    if (
      resourceScopes.length === 0
      || !authorizationScopes.includes("offline_access")
    ) {
      return undefined;
    }
    return [...new Set([...resourceScopes, "offline_access"])].join(" ");
  }

  private setState(
    state: McpConnectionRuntimeState,
    detail?: string,
  ): void {
    this.runtimeState = state;
    this.runtimeDetail = detail;
    this.onStateChange?.(state, detail);
  }
}

type CoordinatedOAuthProviderOptions = {
  callbackUrl: URL;
  credential: McpOAuthCredential;
  authorizationState: string;
  onRedirect: (url: URL) => Promise<void>;
  onCommit: (credential: McpOAuthCredential) => Promise<void>;
  retainRefreshToken: boolean;
};

class CoordinatedOAuthProvider implements OAuthClientProvider {
  private credential: McpOAuthCredential;

  constructor(private readonly options: CoordinatedOAuthProviderOptions) {
    this.credential = structuredClone(options.credential);
  }

  get redirectUrl(): URL {
    return this.options.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "PwrAgent",
      redirect_uris: [this.options.callbackUrl.href],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.options.authorizationState;
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
    const refreshToken =
      tokens.refresh_token
      ?? (this.options.retainRefreshToken
        ? this.credential.tokens?.refresh_token
        : undefined);
    this.credential.tokens = {
      ...tokens,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
    this.credential.redirectUrl = this.options.callbackUrl.href;
    await this.options.onCommit(this.snapshot());
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.options.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.credential.codeVerifier = codeVerifier;
    await this.persistIfAuthorized();
  }

  codeVerifier(): string {
    if (!this.credential.codeVerifier) {
      throw new Error("The MCP OAuth code verifier is unavailable.");
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
  }

  private snapshot(): McpOAuthCredential {
    return structuredClone(this.credential);
  }

  private async persistIfAuthorized(): Promise<void> {
    if (this.credential.tokens?.access_token) {
      await this.options.onCommit(this.snapshot());
    }
  }
}

function isAuthorizationFailure(error: unknown): boolean {
  if (error instanceof McpReauthorizationRequiredError) return true;
  const message = errorMessage(error).toLowerCase();
  return message.includes("invalid_grant")
    || message.includes("unauthorized_client")
    || message.includes("invalid client")
    || message.includes("refresh token");
}

function errorMessage(error: unknown): string {
  return redactOAuthSecrets(
    error instanceof Error ? error.message : String(error),
  );
}

function redactOAuthSecrets(value: string): string {
  return value
    .replace(
      /([?&](?:code|access_token|refresh_token|client_secret)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(
      /("(?:access_token|refresh_token|client_secret|code)"\s*:\s*")[^"]*/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]");
}
