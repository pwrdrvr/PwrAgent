import { createHash } from "node:crypto";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  CloudflareAccessOAuth,
  CloudflareSignInCancelledError,
  CloudflareSignInRequiredError,
  pkceChallenge,
  pkceVerifier,
  type CloudflareAccessSession,
} from "../federation/cloudflare-access-oauth";

const ENDPOINT = "wss://federation.example.com";
const TEAM = "https://team.cloudflareaccess.com";

type Call = { url: string; method: string; body: string };

/**
 * A Managed OAuth server shaped like Cloudflare's: RFC 8414 metadata on the
 * application host, dynamic registration, and a token endpoint that verifies
 * PKCE and rotates refresh tokens.
 */
function fakeAccess(overrides: {
  metadata?: Record<string, unknown> | null;
  protectedResource?: Record<string, unknown>;
  teamMetadata?: Record<string, unknown>;
  token?: (form: URLSearchParams) => { status: number; body: Record<string, unknown> } | undefined;
} = {}) {
  const calls: Call[] = [];
  let challenge = "";
  let refresh = "refresh-1";
  let issued = 1;
  const metadata = {
    issuer: TEAM,
    authorization_endpoint: `${TEAM}/cdn-cgi/access/oauth/authorize`,
    token_endpoint: `${TEAM}/cdn-cgi/access/oauth/token`,
    registration_endpoint: `${TEAM}/cdn-cgi/access/oauth/register`,
    code_challenge_methods_supported: ["S256"],
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url === "https://federation.example.com/.well-known/oauth-authorization-server") {
      return overrides.metadata === null ? json(404, {}) : json(200, overrides.metadata ?? metadata);
    }
    if (url === "https://federation.example.com/.well-known/cloudflare-access-protected-resource/") {
      return json(200, overrides.protectedResource ?? {});
    }
    if (url === `${TEAM}/.well-known/oauth-authorization-server`) return json(200, overrides.teamMetadata ?? metadata);
    if (url === metadata.registration_endpoint) return json(201, { client_id: "client-1" });
    if (url === metadata.token_endpoint) {
      const form = new URLSearchParams(body);
      const custom = overrides.token?.(form);
      if (custom) return json(custom.status, custom.body);
      if (form.get("grant_type") === "authorization_code") {
        const verified = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === challenge;
        if (form.get("code") !== "code-1" || !verified) return json(400, { error: "invalid_grant" });
      } else if (form.get("refresh_token") !== refresh) {
        return json(400, { error: "invalid_grant" });
      }
      issued += 1;
      refresh = `refresh-${issued}`;
      return json(200, { access_token: `oauth:access-${issued}`, refresh_token: refresh, expires_in: 900, token_type: "Bearer" });
    }
    return json(404, {});
  });
  return {
    calls,
    fetch: fetch as unknown as typeof globalThis.fetch,
    fetchSpy: fetch,
    setChallenge: (value: string) => { challenge = value; },
    currentRefresh: () => refresh,
  };
}

/** What the operator's browser does after Access approves: follow the redirect. */
function visit(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

function harness(options: {
  access?: ReturnType<typeof fakeAccess>;
  session?: CloudflareAccessSession;
  now?: () => number;
  browser?: (authorize: URL, access: ReturnType<typeof fakeAccess>) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
} = {}) {
  const access = options.access ?? fakeAccess();
  let stored = options.session ? structuredClone(options.session) : undefined;
  const pages: string[] = [];
  const opened: URL[] = [];
  const openExternal = vi.fn(async (value: string) => {
    const authorize = new URL(value);
    opened.push(authorize);
    access.setChallenge(authorize.searchParams.get("code_challenge") ?? "");
    if (options.browser) return options.browser(authorize, access);
    const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "code-1");
    redirect.searchParams.set("state", authorize.searchParams.get("state")!);
    pages.push((await visit(redirect.toString())).body);
  });
  const oauth = new CloudflareAccessOAuth({
    load: async () => stored ? structuredClone(stored) : undefined,
    save: async (session) => { stored = session ? structuredClone(session) : undefined; },
    openExternal,
    fetch: access.fetch,
    now: options.now,
    signInTimeoutMs: 5_000,
    log: options.log,
  });
  return { oauth, access, openExternal, opened, pages, stored: () => stored };
}

describe("Cloudflare Access sign-in", () => {
  it("signs in with PKCE over a loopback redirect and stores a refreshable grant", async () => {
    const h = harness();
    await h.oauth.signIn(ENDPOINT);

    const registration = JSON.parse(h.access.calls.find((call) => call.url.endsWith("/register"))!.body);
    expect(registration.redirect_uris).toHaveLength(1);
    expect(registration.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(registration).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      resource: "https://federation.example.com",
    });

    const authorize = h.opened[0];
    expect(authorize.origin + authorize.pathname).toBe(`${TEAM}/cdn-cgi/access/oauth/authorize`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe("https://federation.example.com");
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    expect(authorize.searchParams.get("redirect_uri")).toBe(registration.redirect_uris[0]);

    const exchange = new URLSearchParams(h.access.calls.find((call) => call.url.endsWith("/token"))!.body);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("resource")).toBe("https://federation.example.com");
    expect(exchange.get("redirect_uri")).toBe(registration.redirect_uris[0]);

    expect(h.stored()).toMatchObject({ endpoint: ENDPOINT, clientId: "client-1", refreshToken: "refresh-2", accessToken: "oauth:access-2" });
    expect(h.pages[0]).toContain("PwrAgent is signed in");
    expect((await h.oauth.status(ENDPOINT))?.state).toBe("signed-in");
  });

  it("refuses a mismatched state and keeps the previous grant", async () => {
    const previous: CloudflareAccessSession = { version: 1, endpoint: ENDPOINT, clientId: "old", redirectUri: "http://127.0.0.1:1/callback", refreshToken: "kept", signedInAt: 1 };
    const h = harness({
      session: previous,
      browser: async (authorize) => {
        const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "code-1");
        redirect.searchParams.set("state", "forged");
        await visit(redirect.toString());
      },
    });
    await expect(h.oauth.signIn(ENDPOINT)).rejects.toThrow("mismatched state");
    expect(h.access.calls.some((call) => call.url.endsWith("/token"))).toBe(false);
    expect(h.stored()).toEqual(previous);
  });

  it("never opens a browser for metadata that sends tokens outside Cloudflare Access", async () => {
    const access = fakeAccess({ metadata: {
      authorization_endpoint: `${TEAM}/authorize`,
      token_endpoint: "https://collector.example.net/token",
      registration_endpoint: `${TEAM}/register`,
    } });
    const h = harness({ access });
    await expect(h.oauth.signIn(ENDPOINT)).rejects.toThrow("outside Cloudflare Access");
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(access.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("finds the authorization server through the protected-resource document", async () => {
    const access = fakeAccess({ metadata: null, protectedResource: { authorization_servers: [TEAM] } });
    const h = harness({ access });
    await h.oauth.signIn(ENDPOINT);
    expect(h.stored()?.refreshToken).toBe("refresh-2");
  });

  it("will not follow a protected-resource document off Cloudflare", async () => {
    const access = fakeAccess({ metadata: null, protectedResource: { authorization_servers: ["https://login.example.net"] } });
    const h = harness({ access });
    await expect(h.oauth.signIn(ENDPOINT)).rejects.toThrow("does not offer sign-in");
    expect(access.calls.some((call) => call.url.startsWith("https://login.example.net"))).toBe(false);
  });

  it("requires a refresh token, since fifteen-minute access alone is not a usable gate", async () => {
    const access = fakeAccess({ token: () => ({ status: 200, body: { access_token: "oauth:x", expires_in: 900 } }) });
    const h = harness({ access });
    await expect(h.oauth.signIn(ENDPOINT)).rejects.toThrow("refresh token");
    expect(h.stored()).toBeUndefined();
  });

  it("releases a sign-in whose browser tab was abandoned", async () => {
    const h = harness({ browser: async () => undefined });
    const pending = h.oauth.signIn(ENDPOINT);
    await vi.waitFor(() => expect(h.openExternal).toHaveBeenCalled());
    h.oauth.cancel();
    await expect(pending).rejects.toThrow("cancelled");
    // The latch is released: a new sign-in can start.
    const retry = h.oauth.signIn(ENDPOINT);
    await vi.waitFor(() => expect(h.openExternal).toHaveBeenCalledTimes(2));
    h.oauth.cancel();
    await expect(retry).rejects.toThrow("cancelled");
  });

  it("reports a cancel as its own outcome, so it is not shown as a failure", async () => {
    const h = harness({ browser: async () => undefined });
    const pending = h.oauth.signIn(ENDPOINT);
    await vi.waitFor(() => expect(h.openExternal).toHaveBeenCalled());
    h.oauth.cancel();
    await expect(pending).rejects.toBeInstanceOf(CloudflareSignInCancelledError);
  });

  it("reopens a waiting sign-in's page, which completes it after a refused login method", async () => {
    // First visit: a login method refused the person and Access continued with
    // an ordinary login for the application, so the redirect never came back.
    let attempts = 0;
    const log = vi.fn();
    const h = harness({
      browser: async (authorize) => {
        attempts += 1;
        if (attempts === 1) return;
        const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "code-1");
        redirect.searchParams.set("state", authorize.searchParams.get("state")!);
        await visit(redirect.toString());
      },
      log,
    });
    await expect(h.oauth.reopen()).resolves.toBe(false);
    const pending = h.oauth.signIn(ENDPOINT);
    await vi.waitFor(() => expect(h.openExternal).toHaveBeenCalledTimes(1));
    await expect(h.oauth.reopen()).resolves.toBe(true);
    await pending;
    // The same authorization, not a second registration or a new PKCE pair.
    expect(h.opened[1].toString()).toBe(h.opened[0].toString());
    expect(h.access.calls.filter((call) => call.url.endsWith("/register"))).toHaveLength(1);
    expect(h.stored()).toMatchObject({ accessToken: "oauth:access-2" });
    await expect(h.oauth.reopen()).resolves.toBe(false);
    // Progress is logged without a code or a token.
    expect(log.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      "Cloudflare sign-in opened the browser", "Cloudflare sign-in reopened the browser",
      "Cloudflare sign-in returned to PwrAgent", "Cloudflare sign-in completed",
    ]));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/code-1|access-2|refresh-2/);
  });
});

describe("Cloudflare Access tokens", () => {
  const now = 1_000_000_000_000;
  const session = (overrides: Partial<CloudflareAccessSession> = {}): CloudflareAccessSession => ({
    version: 1, endpoint: ENDPOINT, clientId: "client-1", redirectUri: "http://127.0.0.1:1/callback",
    refreshToken: "refresh-1", accessToken: "oauth:access-1", accessExpiresAt: now + 10 * 60_000, signedInAt: now - 1000,
    ...overrides,
  });

  it("schedules the next refresh a minute before the access token expires", async () => {
    const h = harness({ session: session(), now: () => now });
    await expect(h.oauth.refreshDueAt(ENDPOINT)).resolves.toBe(now + 9 * 60_000);
    await expect(h.oauth.refreshDueAt("wss://other.example.com")).resolves.toBeUndefined();
  });

  it("returns a fresh access token without touching the network", async () => {
    const h = harness({ session: session(), now: () => now });
    await expect(h.oauth.accessToken(ENDPOINT)).resolves.toBe("oauth:access-1");
    expect(h.access.fetchSpy).not.toHaveBeenCalled();
  });

  it("treats wss://host/ and wss://host as one endpoint", async () => {
    const h = harness({ session: session(), now: () => now });
    await expect(h.oauth.accessToken(`${ENDPOINT}/`)).resolves.toBe("oauth:access-1");
  });

  it("refreshes once for concurrent callers and keeps the rotated refresh token", async () => {
    const h = harness({ session: session({ accessExpiresAt: now + 30_000 }), now: () => now });
    const [first, second] = await Promise.all([h.oauth.accessToken(ENDPOINT), h.oauth.accessToken(ENDPOINT)]);
    expect(first).toBe("oauth:access-2");
    expect(second).toBe("oauth:access-2");
    const refreshes = h.access.calls.filter((call) => call.url.endsWith("/token"));
    expect(refreshes).toHaveLength(1);
    const form = new URLSearchParams(refreshes[0].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("resource")).toBe("https://federation.example.com");
    expect(h.stored()?.refreshToken).toBe(h.access.currentRefresh());
  });

  it("turns a refused refresh into sign-in required and stops calling Cloudflare", async () => {
    const h = harness({ session: session({ accessToken: undefined, refreshToken: "revoked" }), now: () => now });
    await expect(h.oauth.accessToken(ENDPOINT)).rejects.toBeInstanceOf(CloudflareSignInRequiredError);
    expect(h.stored()).toMatchObject({ signInRequired: true, clientId: "client-1" });
    expect(h.stored()?.refreshToken).toBeUndefined();
    const calls = h.access.calls.length;
    await expect(h.oauth.accessToken(ENDPOINT)).rejects.toBeInstanceOf(CloudflareSignInRequiredError);
    expect(h.access.calls).toHaveLength(calls);
    expect((await h.oauth.status(ENDPOINT))?.state).toBe("sign-in-required");
  });

  it("keeps the grant through a transient refresh failure", async () => {
    const access = fakeAccess({ token: () => ({ status: 503, body: {} }) });
    const h = harness({ access, session: session({ accessToken: undefined }), now: () => now });
    await expect(h.oauth.accessToken(ENDPOINT)).rejects.not.toBeInstanceOf(CloudflareSignInRequiredError);
    expect(h.stored()).toMatchObject({ refreshToken: "refresh-1" });
    expect(h.stored()?.signInRequired).toBeUndefined();
  });

  it("refreshes after the edge refuses a token that looked fresh", async () => {
    const h = harness({ session: session(), now: () => now });
    await h.oauth.invalidateAccessToken(ENDPOINT);
    await expect(h.oauth.accessToken(ENDPOINT)).resolves.toBe("oauth:access-2");
  });

  it("asks for sign-in when no grant exists for this endpoint", async () => {
    const h = harness({ session: session({ endpoint: "wss://other.example.com" }), now: () => now });
    await expect(h.oauth.accessToken(ENDPOINT)).rejects.toBeInstanceOf(CloudflareSignInRequiredError);
    expect((await h.oauth.status(ENDPOINT))?.state).toBe("signed-out");
  });
});

describe("PKCE", () => {
  it("derives an S256 challenge that starts with a letter or digit", () => {
    // Cloudflare documents that a challenge starting with - or _ fails to parse.
    for (let index = 0; index < 200; index++) {
      const verifier = pkceVerifier();
      const challenge = pkceChallenge(verifier);
      expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
      expect(challenge).toMatch(/^[A-Za-z0-9]/);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
    }
  });
});
