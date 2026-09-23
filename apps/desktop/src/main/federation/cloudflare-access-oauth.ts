import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CloudflareSignInStatus } from "@pwragent/shared";
import { isUnresolvedHost, unresolvedHostMessage } from "./cloudflare-dns";

/**
 * Client half of the `oauth` gate: this instance signing a person in to a
 * Cloudflare Access application that has Managed OAuth enabled.
 *
 * Cloudflare's flow is plain OAuth 2.0 — RFC 8414 discovery, RFC 7591 dynamic
 * registration of a public client, authorization code with PKCE (S256), and
 * RFC 8707 resource indicators. The browser leg runs in the operator's own
 * browser, not an embedded window: their password manager and passkeys work,
 * and identity providers that refuse embedded sign-in (Google does) still work.
 *
 * Access tokens are opaque and short-lived (15 minutes by default); the grant
 * behind them lasts two weeks. PwrAgent refreshes before each connection, so a
 * person signs in again only after the grant lapses or they lose access.
 */

export type CloudflareAccessSession = {
  version: 1;
  /** The federation endpoint this grant is for, `wss://host`. */
  endpoint: string;
  clientId?: string;
  redirectUri?: string;
  refreshToken?: string;
  accessToken?: string;
  accessExpiresAt?: number;
  signedInAt?: number;
  /** Set when a refresh was refused; only an interactive sign-in clears it. */
  signInRequired?: boolean;
  lastError?: string;
};

type Metadata = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
};

type TokenResult = { accessToken: string; refreshToken?: string; expiresAt: number };

/**
 * A connection that cannot proceed until a person signs in.
 *
 * The message is also the runtime's auth-class failure marker, so a lapsed
 * grant reads as "rejected" in Federation health rather than as an endless
 * "connecting" retry that no amount of waiting will fix.
 */
export class CloudflareSignInRequiredError extends Error {
  constructor(detail?: string) {
    super(`${CLOUDFLARE_SIGN_IN_REQUIRED}${detail ? ` ${detail}` : ""}`);
  }
}

/**
 * Cloudflare's edge answered and refused this client's service token or
 * certificate: the gateway is reachable, and the credential is what failed.
 * Retrying cannot fix it, so like a lapsed sign-in it reads as rejected.
 */
export class CloudflareAccessRefusedError extends Error {
  constructor(host: string) {
    super(`${CLOUDFLARE_ACCESS_REFUSED} for ${host}. It may have been revoked or expired; `
      + "ask the gateway's operator for a new client setup file.");
  }
}

export const CLOUDFLARE_ACCESS_REFUSED = "Cloudflare Access refused this client's credential";

/** The person abandoned a sign-in; nothing was saved, so an existing grant stands. */
export class CloudflareSignInCancelledError extends Error {
  constructor() { super("Cloudflare sign-in was cancelled."); }
}

export const CLOUDFLARE_SIGN_IN_REQUIRED =
  "Cloudflare Access sign-in is required. Open Settings → Federation → Cloudflare Access and choose Sign in.";

export type CloudflareAccessOAuthDependencies = {
  load: () => Promise<CloudflareAccessSession | undefined>;
  /** `undefined` removes the stored session. */
  save: (session: CloudflareAccessSession | undefined) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  signInTimeoutMs?: number;
  /** Sign-in progress, for the log. Never given a code, token, or secret. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

const REFRESH_MARGIN_MS = 60_000;
const RESPONSE_LIMIT = 64 * 1024;
const CALLBACK_PATH = "/callback";

export class CloudflareAccessOAuth {
  private refreshing?: Promise<string>;
  private signingIn = false;
  private cancelRequested = false;
  private cancelSignIn?: () => void;
  private pendingSignIn?: { authorizeUrl: string; extend: () => void };
  private metadata?: { host: string; value: Metadata; expires: number };
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: CloudflareAccessOAuthDependencies) {
    this.fetcher = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  async status(endpoint: string | undefined): Promise<CloudflareSignInStatus | undefined> {
    if (!endpoint) return undefined;
    const session = await this.deps.load().catch(() => undefined);
    if (!session || !sameEndpoint(session.endpoint, endpoint)) return { endpoint, state: "signed-out" };
    const state = session.signInRequired || !session.refreshToken && !this.hasFreshAccessToken(session)
      ? session.signedInAt ? "sign-in-required" : "signed-out"
      : "signed-in";
    return {
      endpoint,
      state,
      signedInAt: session.signedInAt ? new Date(session.signedInAt).toISOString() : undefined,
      accessExpiresAt: session.accessExpiresAt ? new Date(session.accessExpiresAt).toISOString() : undefined,
      lastError: session.lastError,
    };
  }

  /**
   * A bearer token for `endpoint`, refreshed when it is within a minute of
   * expiry. Concurrent callers share one refresh, because a rotated refresh
   * token is single-use and a second exchange would revoke the grant.
   */
  async accessToken(endpoint: string): Promise<string> {
    const session = await this.deps.load();
    if (!session || !sameEndpoint(session.endpoint, endpoint) || session.signInRequired) {
      throw new CloudflareSignInRequiredError();
    }
    if (this.hasFreshAccessToken(session)) return session.accessToken!;
    if (!session.refreshToken || !session.clientId) throw new CloudflareSignInRequiredError();
    this.refreshing ??= this.refresh(session).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /**
   * When `endpoint`'s access token next needs a refresh, or undefined without
   * one. A connection that stays open refreshes on this schedule, because the
   * refresh is where Access re-evaluates whether the person may still get in.
   */
  async refreshDueAt(endpoint: string): Promise<number | undefined> {
    const session = await this.deps.load().catch(() => undefined);
    if (!session || !sameEndpoint(session.endpoint, endpoint) || !session.accessExpiresAt) return undefined;
    return session.accessExpiresAt - REFRESH_MARGIN_MS;
  }

  /**
   * Forget the cached access token after the edge refused it, so the next
   * connection refreshes instead of presenting it again. The grant is kept:
   * the refresh itself is what tells an expired token from a revoked person.
   */
  async invalidateAccessToken(endpoint: string): Promise<void> {
    const session = await this.deps.load();
    if (!session || !sameEndpoint(session.endpoint, endpoint) || !session.accessToken) return;
    await this.deps.save({ ...session, accessToken: undefined, accessExpiresAt: undefined });
  }

  async signOut(): Promise<void> {
    const session = await this.deps.load().catch(() => undefined);
    await this.deps.save(undefined);
    // Best effort: revoke the grant server-side when Cloudflare advertises a
    // revocation endpoint. The local copy is already gone either way.
    if (!session?.refreshToken || !session.clientId) return;
    try {
      const metadata = await this.discover(session.endpoint);
      if (!metadata.revocationEndpoint) return;
      await this.post(metadata.revocationEndpoint, {
        token: session.refreshToken,
        token_type_hint: "refresh_token",
        client_id: session.clientId,
      });
    } catch { /* Revocation is advisory; sign-out already succeeded locally. */ }
  }

  /**
   * Interactive sign-in: open the operator's browser at Access's authorization
   * endpoint and wait on 127.0.0.1 for the redirect.
   */
  async signIn(endpoint: string): Promise<void> {
    if (this.signingIn) throw new Error("A Cloudflare sign-in is already waiting in your browser.");
    this.signingIn = true;
    this.cancelRequested = false;
    try {
      // Inside the try: an endpoint this refuses must still release the latch,
      // or every later sign-in reads as already waiting until a restart.
      const resource = resourceFor(endpoint);
      const host = new URL(resource).hostname;
      const metadata = await this.discover(endpoint);
      const previous = await this.deps.load().catch(() => undefined);
      const reuse = previous && sameEndpoint(previous.endpoint, endpoint) ? previous : undefined;
      const listener = await listenForCallback(reuse?.redirectUri);
      this.cancelSignIn = listener.cancel;
      try {
        if (this.cancelRequested) throw new CloudflareSignInCancelledError();
        // A registered client is bound to its exact redirect URI. Reusing the
        // previous port keeps one registration per machine; a port someone else
        // now holds means registering again rather than failing.
        // Nothing is saved until the exchange succeeds, so an abandoned sign-in
        // leaves an existing grant exactly as it was.
        let clientId = reuse?.clientId;
        if (!clientId || reuse?.redirectUri !== listener.redirectUri) {
          clientId = await this.register(metadata, listener.redirectUri, resource);
          this.deps.log?.("Cloudflare sign-in registered this computer", { host, redirectUri: listener.redirectUri });
        }
        const verifier = pkceVerifier();
        const state = base64url(randomBytes(32));
        const authorize = new URL(metadata.authorizationEndpoint);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("client_id", clientId);
        authorize.searchParams.set("redirect_uri", listener.redirectUri);
        authorize.searchParams.set("code_challenge", pkceChallenge(verifier));
        authorize.searchParams.set("code_challenge_method", "S256");
        authorize.searchParams.set("state", state);
        authorize.searchParams.set("resource", resource);
        const timeoutMs = this.deps.signInTimeoutMs ?? 5 * 60_000;
        const callback = listener.next(timeoutMs);
        // Handled below; this only keeps a failed browser launch from leaving
        // the pending wait as an unhandled rejection.
        callback.catch(() => undefined);
        // A cancel that arrived during discovery or registration ends the
        // sign-in here, before a browser opens for a person who said no.
        if (this.cancelRequested) throw new CloudflareSignInCancelledError();
        this.pendingSignIn ={ authorizeUrl: authorize.toString(), extend: () => listener.extend(timeoutMs) };
        await this.deps.openExternal(authorize.toString());
        this.deps.log?.("Cloudflare sign-in opened the browser", { host });
        const { code, returnedState } = await callback.catch((error: unknown) => {
          this.deps.log?.("Cloudflare sign-in ended without a code", {
            host, reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        });
        this.deps.log?.("Cloudflare sign-in returned to PwrAgent", { host });
        if (returnedState !== state) throw new Error("Cloudflare sign-in returned a mismatched state. Try again.");
        const tokens = await this.exchange(metadata.tokenEndpoint, {
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: listener.redirectUri,
          code_verifier: verifier,
          resource,
        }).catch((error: unknown) => {
          throw new Error(`The browser returned, but PwrAgent could not finish exchanging the sign-in code. ${error instanceof Error ? error.message : "Retry sign-in."}`, { cause: error });
        });
        if (!tokens.refreshToken) {
          // Without a refresh token every connection after fifteen minutes would
          // need the browser again, which is not a usable gate.
          throw new Error("Cloudflare did not issue a refresh token. Check the application's Managed OAuth grant settings.");
        }
        await this.deps.save({
          version: 1, endpoint, clientId, redirectUri: listener.redirectUri,
          refreshToken: tokens.refreshToken, accessToken: tokens.accessToken,
          accessExpiresAt: tokens.expiresAt, signedInAt: this.now(),
        });
        this.deps.log?.("Cloudflare sign-in completed", { host });
      } finally {
        this.cancelSignIn = undefined;
        this.pendingSignIn = undefined;
        listener.close();
      }
    } finally {
      this.signingIn = false;
    }
  }

  /** Whether a sign-in is waiting on the browser right now. */
  pending(): boolean {
    return Boolean(this.pendingSignIn);
  }

  /**
   * Abandon a sign-in, e.g. after its tab was closed. One still discovering or
   * registering, before it waits on the browser, stops before opening it.
   */
  cancel(): void {
    if (!this.signingIn) return;
    this.cancelRequested = true;
    this.cancelSignIn?.();
  }

  /**
   * Send the browser back to the waiting sign-in's authorization page, and give
   * it a fresh wait.
   *
   * When a login method refuses the person (GitHub reporting an email the
   * allowlist lacks), Access continues with an ordinary login for the
   * application's own domain, and the redirect back to PwrAgent is lost. The
   * pending sign-in is still valid: reopening its authorization page with the
   * browser's new Access session goes straight to consent and returns here.
   */
  async reopen(): Promise<boolean> {
    const pending = this.pendingSignIn;
    if (!pending) return false;
    pending.extend();
    await this.deps.openExternal(pending.authorizeUrl);
    this.deps.log?.("Cloudflare sign-in reopened the browser");
    return true;
  }

  /**
   * Read `endpoint`'s sign-in metadata exactly as `signIn` would, uncached,
   * and name the host a person will be sent to. The gateway's validation uses
   * this to prove clients will be offered sign-in, without signing anyone in.
   */
  async probe(endpoint: string): Promise<string> {
    const metadata = await this.fetchMetadata(new URL(resourceFor(endpoint)).hostname);
    return new URL(metadata.authorizationEndpoint).hostname;
  }

  private hasFreshAccessToken(session: CloudflareAccessSession): boolean {
    return Boolean(session.accessToken && session.accessExpiresAt
      && session.accessExpiresAt - REFRESH_MARGIN_MS > this.now());
  }

  private async refresh(session: CloudflareAccessSession): Promise<string> {
    let tokens: TokenResult;
    try {
      const metadata = await this.discover(session.endpoint);
      tokens = await this.exchange(metadata.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: session.refreshToken!,
        client_id: session.clientId!,
        resource: resourceFor(session.endpoint),
      });
    } catch (error) {
      if (error instanceof GrantRefusedError) {
        // The grant expired or the person no longer passes the policy — Access
        // re-evaluates on every refresh. Keep the registration, drop the grant.
        await this.deps.save({
          version: 1, endpoint: session.endpoint, clientId: error.clientRejected ? undefined : session.clientId,
          redirectUri: error.clientRejected ? undefined : session.redirectUri,
          signedInAt: session.signedInAt, signInRequired: true, lastError: error.message,
        });
        throw new CloudflareSignInRequiredError();
      }
      throw error;
    }
    await this.deps.save({
      ...session,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      // Refresh tokens may rotate; the previous one is then already spent.
      refreshToken: tokens.refreshToken ?? session.refreshToken,
      signInRequired: false,
      lastError: undefined,
    });
    return tokens.accessToken;
  }

  /**
   * RFC 8414 metadata for the application.
   *
   * Cloudflare serves it on the application's own hostname; the RFC 9728
   * protected-resource document is the fallback path to the team domain. Every
   * endpoint must be https on that hostname or on a `cloudflareaccess.com` team
   * domain, because the refresh token is posted to whatever this returns.
   */
  private async discover(endpoint: string): Promise<Metadata> {
    const host = new URL(resourceFor(endpoint)).hostname;
    // Metadata changes only when the application is reconfigured, so an hour
    // spares every fifteen-minute refresh two extra round trips.
    if (this.metadata?.host === host && this.metadata.expires > this.now()) return this.metadata.value;
    const value = await this.fetchMetadata(host);
    this.metadata = { host, value, expires: this.now() + 3_600_000 };
    return value;
  }

  private async fetchMetadata(host: string): Promise<Metadata> {
    const failures: unknown[] = [];
    const fetched = (error: unknown) => { failures.push(error); return undefined; };
    let document = await this.getJson(`https://${host}/.well-known/oauth-authorization-server`).catch(fetched);
    if (!hasOAuthEndpoints(document)) {
      const resource = await this.getJson(`https://${host}/.well-known/cloudflare-access-protected-resource/`).catch(fetched);
      const server = Array.isArray((resource as { authorization_servers?: unknown })?.authorization_servers)
        ? (resource as { authorization_servers: unknown[] }).authorization_servers[0]
        : undefined;
      if (typeof server === "string" && trustedOAuthUrl(server, host)) {
        document = await this.getJson(`${server.replace(/\/$/, "")}/.well-known/oauth-authorization-server`).catch(fetched);
      }
    }
    if (!hasOAuthEndpoints(document)) {
      this.deps.log?.("Cloudflare sign-in metadata unavailable", {
        host, reasons: failures.map((error) => error instanceof Error ? error.message : String(error)),
      });
      // Only a host that answered can be said to lack sign-in.
      if (failures.some(isUnresolvedHost)) throw new Error(unresolvedHostMessage(host));
      const networkFailure = failures.find((error) => error instanceof Error && error.cause);
      if (networkFailure) throw networkFailure;
      throw new Error("This Cloudflare endpoint does not offer sign-in. Managed OAuth may be off on its Access application.");
    }
    const metadata = {
      authorizationEndpoint: document.authorization_endpoint,
      tokenEndpoint: document.token_endpoint,
      registrationEndpoint: document.registration_endpoint,
      revocationEndpoint: typeof document.revocation_endpoint === "string" ? document.revocation_endpoint : undefined,
    };
    const urls = [metadata.authorizationEndpoint, metadata.tokenEndpoint, metadata.registrationEndpoint,
      ...(metadata.revocationEndpoint ? [metadata.revocationEndpoint] : [])];
    if (!urls.every((url) => trustedOAuthUrl(url, host))) {
      throw new Error("Cloudflare sign-in metadata points outside Cloudflare Access. Sign-in was not started.");
    }
    const methods = (document as { code_challenge_methods_supported?: unknown }).code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes("S256")) {
      throw new Error("This Cloudflare endpoint does not support PKCE S256 sign-in.");
    }
    return metadata;
  }

  private async register(metadata: Metadata, redirectUri: string, resource: string): Promise<string> {
    const response = await this.send(metadata.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "PwrAgent",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        resource,
      }),
    });
    const clientId = (response.body as { client_id?: unknown })?.client_id;
    if (!response.ok || typeof clientId !== "string" || !clientId || clientId.length > 512) {
      throw new Error(`Cloudflare refused to register PwrAgent for sign-in (HTTP ${response.status}). Check that Managed OAuth allows loopback clients.`);
    }
    return clientId;
  }

  private async exchange(tokenEndpoint: string, form: Record<string, string>): Promise<TokenResult> {
    const response = await this.post(tokenEndpoint, form);
    const body = (response.body ?? {}) as {
      access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown; error?: unknown;
    };
    if (!response.ok) {
      const code = typeof body.error === "string" ? body.error : "";
      if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") {
        throw new GrantRefusedError(code);
      }
      throw new Error(`Cloudflare sign-in failed (HTTP ${response.status}${code ? ` ${code.slice(0, 60)}` : ""}).`);
    }
    if (typeof body.access_token !== "string" || !body.access_token || body.access_token.length > 8192
      || (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer")) {
      throw new Error("Cloudflare returned an unusable sign-in token.");
    }
    const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 900;
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined,
      expiresAt: this.now() + lifetime * 1000,
    };
  }

  private post(url: string, form: Record<string, string>) {
    return this.send(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.send(url, { method: "GET", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.body;
  }

  private async send(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
    let response: Response;
    let text: string;
    try {
      // No redirects: a bearer or refresh token must only go where discovery,
      // after its host check, said to send it.
      response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
      text = (await response.text()).slice(0, RESPONSE_LIMIT);
    } catch (error) {
      // Kept as the cause so a failed lookup can still be told apart.
      const target = new URL(url);
      const cause = error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined;
      const reason = typeof cause?.code === "string" && /^[A-Z_]+$/.test(cause.code)
        ? cause.code : error instanceof Error && error.name === "TimeoutError" ? "request timed out" : "network request failed";
      this.deps.log?.("Cloudflare endpoint request failed", { host: target.hostname, path: target.pathname, reason });
      throw new Error(`Could not reach the Cloudflare-protected sign-in endpoint ${target.hostname} (${reason}). Check your connection and retry sign-in in PwrAgent.`, { cause: error });
    }
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    return { ok: response.ok, status: response.status, body };
  }
}

class GrantRefusedError extends Error {
  readonly clientRejected: boolean;
  constructor(code: string) {
    super(code === "invalid_grant"
      ? "Your Cloudflare sign-in expired or no longer passes the Access policy."
      : "Cloudflare no longer recognizes this PwrAgent sign-in registration.");
    this.clientRejected = code !== "invalid_grant";
  }
}

/** RFC 8707 resource: the https origin Access protects. */
export function resourceFor(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "wss:" && url.protocol !== "https:") throw new Error("Cloudflare sign-in needs a wss:// endpoint.");
  if (url.username || url.password || url.port) throw new Error("Cloudflare sign-in needs a standard endpoint address.");
  return `https://${url.hostname}`;
}

/**
 * The runtime scopes Cloudflare credentials by host, so a grant for
 * `wss://host` must also serve `wss://host/`. Compared as the resource origin.
 */
function sameEndpoint(a: string, b: string): boolean {
  try { return resourceFor(a) === resourceFor(b); } catch { return false; }
}

function trustedOAuthUrl(value: string, host: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.hostname === host || url.hostname.endsWith(".cloudflareaccess.com"));
  } catch { return false; }
}

function hasOAuthEndpoints(value: unknown): value is {
  authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; revocation_endpoint?: unknown;
} {
  const document = value as Record<string, unknown> | undefined;
  return Boolean(document && typeof document === "object"
    && typeof document.authorization_endpoint === "string"
    && typeof document.token_endpoint === "string"
    && typeof document.registration_endpoint === "string");
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * A PKCE verifier whose S256 challenge starts with a letter or digit.
 * Cloudflare documents that a challenge beginning with `-` or `_` fails URL
 * parsing on its side, so draw again — two in 64 draws need a retry.
 */
export function pkceVerifier(): string {
  for (;;) {
    const verifier = base64url(randomBytes(32));
    if (/^[A-Za-z0-9]/.test(pkceChallenge(verifier))) return verifier;
  }
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>PwrAgent</title>`
    + `<body style="font:15px system-ui;margin:48px;max-width:32em"><h1 style="font-size:18px">${escapeHtml(title)}</h1>`
    + `<p>${escapeHtml(detail)}</p></body>`;
}

/**
 * One-shot loopback listener for the authorization redirect.
 *
 * Bound to 127.0.0.1 only, so nothing off this machine can deliver a code.
 * Unrelated paths (a favicon fetch) get a 404 and do not consume the wait.
 */
const SIGN_IN_TIMED_OUT = "Cloudflare sign-in timed out waiting for the browser. Try again, and sign in with an email "
  + "the gateway allows; one-time PIN works with any address.";

async function listenForCallback(previousRedirect: string | undefined) {
  let settle: ((value: { code: string; returnedState: string }) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  // A cancel can arrive while registration is still in flight, before the
  // wait exists; remember it so the wait rejects as soon as it starts.
  let cancelled = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    if (code) {
      response.end(page("Sign-in response received", "Return to PwrAgent to check the result. PwrAgent still needs to finish signing in and connect to your gateway."));
      settle?.({ code, returnedState });
    } else {
      const detail = (url.searchParams.get("error_description") ?? error ?? "No authorization code was returned.").slice(0, 200);
      response.end(page("Sign-in did not complete", detail));
      fail?.(new Error(`Cloudflare sign-in did not complete: ${detail.replace(/\p{Cc}/gu, " ")}`));
    }
  });
  const previousPort = previousRedirect ? Number(new URL(previousRedirect).port) : 0;
  const bind = (port: number) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  try {
    await bind(previousPort);
  } catch (error) {
    if (!previousPort) throw error;
    await bind(0);
  }
  const port = (server.address() as AddressInfo).port;
  let timer: NodeJS.Timeout | undefined;
  let expire: (() => void) | undefined;
  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    next: (timeoutMs: number) => new Promise<{ code: string; returnedState: string }>((resolve, reject) => {
      if (cancelled) {
        reject(new CloudflareSignInCancelledError());
        return;
      }
      expire = () => reject(new Error(SIGN_IN_TIMED_OUT));
      timer = setTimeout(expire, timeoutMs);
      settle = (value) => { clearTimeout(timer); resolve(value); };
      fail = (error) => { clearTimeout(timer); reject(error); };
    }),
    /** Restart the wait, for a person who is still trying. */
    extend: (timeoutMs: number) => {
      if (!expire) return;
      clearTimeout(timer);
      timer = setTimeout(expire, timeoutMs);
    },
    cancel: () => {
      cancelled = true;
      fail?.(new CloudflareSignInCancelledError());
    },
    close: () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    },
  };
}
