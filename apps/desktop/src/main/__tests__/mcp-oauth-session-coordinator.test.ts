import { describe, expect, it, vi } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  McpOAuthSessionCoordinator,
  McpReauthorizationRequiredError,
} from "../mcp-connections/mcp-oauth-session-coordinator";
import { createMcpSafeFetch } from "../mcp-connections/mcp-safe-fetch";
import type {
  McpCredentialVault,
  McpOAuthCredential,
} from "../mcp-connections/mcp-credential-vault";

function createVault(initial: McpOAuthCredential) {
  let credential = structuredClone(initial);
  const writes: McpOAuthCredential[] = [];
  const vault = {
    read: vi.fn(async (_connectionId: string, resourceUrl: string) =>
      credential.resourceUrl === resourceUrl
        ? structuredClone(credential)
        : undefined),
    write: vi.fn(async (_connectionId: string, next: McpOAuthCredential) => {
      credential = structuredClone(next);
      writes.push(structuredClone(next));
    }),
    delete: vi.fn(async () => undefined),
  } as unknown as McpCredentialVault;
  return { vault, writes };
}

function refreshAuth(
  implementation: (provider: OAuthClientProvider) => Promise<"AUTHORIZED">,
): typeof auth {
  return vi.fn(implementation) as unknown as typeof auth;
}

describe("McpOAuthSessionCoordinator", () => {
  it("keeps an existing authorization when a reauthorization times out", async () => {
    const { vault, writes } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      discoveryState: { authorizationServerUrl: "https://auth.example.com" },
      tokens: {
        access_token: "existing-access",
        refresh_token: "existing-refresh",
        token_type: "bearer",
      },
    });
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("ok"));
    const coordinator = new McpOAuthSessionCoordinator({
      authFn: vi.fn(async () => "REDIRECT" as const) as unknown as typeof auth,
      connectionId: "example",
      fetchFn,
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    await expect(coordinator.configured()).resolves.toBe(true);
    expect(coordinator.state).toBe("ready");
    await expect(coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect: vi.fn(),
      waitForCode: async () => { throw new Error("Authorization timed out."); },
    })).rejects.toThrow("Authorization timed out.");

    expect(coordinator.state).toBe("ready");
    expect(coordinator.detail).toBeUndefined();
    expect(writes).toHaveLength(0);
    await coordinator.authorizedFetch()("https://mcp.example.com/mcp");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://mcp.example.com/mcp",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const request = fetchFn.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer existing-access");
  });

  it("does not restore a token rejected while reauthorization waits for consent", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      discoveryState: { authorizationServerUrl: "https://auth.example.com" },
      tokens: {
        access_token: "expired-access",
        refresh_token: "invalid-refresh",
        token_type: "bearer",
      },
    });
    let rejectCode: ((error: Error) => void) | undefined;
    const coordinator = new McpOAuthSessionCoordinator({
      authFn: vi.fn(async () => {
        if (!rejectCode) return "REDIRECT" as const;
        throw new Error("invalid_grant: refresh token is invalid");
      }) as unknown as typeof auth,
      connectionId: "example",
      fetchFn: vi.fn(async () => new Response("expired", { status: 401 })),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    const authorization = coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect: vi.fn(),
      waitForCode: () => new Promise<string>((_resolve, reject) => {
        rejectCode = reject;
      }),
    });
    await vi.waitFor(() => expect(rejectCode).toBeDefined());
    await expect(coordinator.authorizedFetch()("https://mcp.example.com/mcp"))
      .rejects.toThrow("can no longer be refreshed");
    expect(coordinator.state).toBe("reauthorization_required");

    rejectCode?.(new Error("Authorization timed out."));
    await expect(authorization).rejects.toThrow("Authorization timed out.");
    expect(coordinator.state).toBe("reauthorization_required");
    expect(coordinator.detail).toContain("invalid_grant");
  });

  it("keeps a credential committed just before its authorization is superseded", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      discoveryState: { authorizationServerUrl: "https://auth.example.com" },
    });
    let committed: (() => void) | undefined;
    let release: (() => void) | undefined;
    const tokenCommitted = new Promise<void>((resolve) => { committed = resolve; });
    const authFn = vi.fn(async (
      provider: OAuthClientProvider,
      options: { authorizationCode?: string },
    ) => {
      if (!options.authorizationCode) return "REDIRECT" as const;
      await provider.saveTokens?.({
        access_token: "committed-access",
        token_type: "bearer",
      });
      committed?.();
      await new Promise<void>((resolve) => { release = resolve; });
      return "AUTHORIZED" as const;
    }) as unknown as typeof auth;
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    const first = coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect: vi.fn(),
      waitForCode: async () => "first",
    });
    const firstFailure = first.catch((error: unknown) => error);
    await tokenCommitted;
    expect(coordinator.state).toBe("connecting");

    coordinator.abandonAuthorization();
    expect(coordinator.state).toBe("ready");
    const second = coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4041/oauth/callback"),
      onRedirect: vi.fn(),
      waitForCode: async () => { throw new Error("Authorization timed out."); },
    });
    release?.();
    expect(await firstFailure).toBeInstanceOf(Error);
    await expect(second).rejects.toThrow("Authorization timed out.");
    expect(coordinator.state).toBe("ready");
    await expect(coordinator.configured()).resolves.toBe(true);
  });

  it("reports an HTML registration failure before opening browser consent", async () => {
    const { vault, writes } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      discoveryState: { authorizationServerUrl: "https://mcp.example.com" },
    });
    const fetchFn = vi.fn(async () => new Response("<!DOCTYPE html><script>challenge-data</script>", {
      status: 403,
      headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
    }));
    const coordinator = new McpOAuthSessionCoordinator({
      connectionId: "example",
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
      fetchFn: createMcpSafeFetch({ fetchFn }),
    });
    const onRedirect = vi.fn();
    const waitForCode = vi.fn();
    await expect(coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect,
      waitForCode,
    })).rejects.toThrow("browser verification");
    expect(coordinator.detail).toContain("HTTP 403");
    expect(coordinator.detail).not.toMatch(/<script>|challenge-data|Raw body/);
    expect(onRedirect).not.toHaveBeenCalled();
    expect(waitForCode).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it.each(["timeout", "late callback", "late token response"])(
    "keeps the newer authorization when an abandoned attempt returns a %s",
    async (outcome) => {
      const { vault, writes } = createVault({
        resourceUrl: "https://mcp.example.com/mcp",
        discoveryState: { authorizationServerUrl: "https://auth.example.com" },
      });
      let release!: () => void;
      let started!: () => void;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      const waiting = new Promise<void>((resolve) => { started = resolve; });
      const authFn = vi.fn(async (
        provider: OAuthClientProvider,
        options: { authorizationCode?: string },
      ) => {
        if (!options.authorizationCode) return "REDIRECT" as const;
        if (options.authorizationCode === "old" && outcome === "late token response") {
          started();
          await paused;
        }
        await provider.saveTokens?.({
          access_token: options.authorizationCode,
          refresh_token: `${options.authorizationCode}-refresh`,
          token_type: "bearer",
        });
        return "AUTHORIZED" as const;
      }) as unknown as typeof auth;
      const coordinator = new McpOAuthSessionCoordinator({
        connectionId: "example",
        serverUrl: new URL("https://mcp.example.com/mcp"),
        vault,
        authFn,
      });
      const old = coordinator.authorize({
        redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
        onRedirect: vi.fn(),
        waitForCode: async () => {
          if (outcome !== "late token response") {
            started();
            await paused;
          }
          if (outcome === "timeout") throw new Error("Authorization timed out.");
          return "old";
        },
      }).catch((error: unknown) => error);
      await waiting;
      await coordinator.authorize({
        redirectUrl: new URL("http://127.0.0.1:4041/oauth/callback"),
        onRedirect: vi.fn(),
        waitForCode: async () => "new",
      });
      release();
      expect(await old).toBeInstanceOf(Error);
      expect(coordinator.state).toBe("ready");
      expect(coordinator.detail).toBeUndefined();
      expect(writes.map((entry) => entry.tokens?.access_token)).toEqual(["new"]);
      expect((await vault.read("example", "https://mcp.example.com/mcp"))?.tokens)
        .toMatchObject({ access_token: "new", refresh_token: "new-refresh" });
    },
  );

  it("advertises refresh grants and requests advertised offline access", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      clientInformation: { client_id: "pwragent-client" },
      discoveryState: {
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          scopes_supported: ["mcp.read", "offline_access"],
        },
        resourceMetadata: {
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["mcp.read"],
        },
      },
    });
    const observedScopes: Array<string | undefined> = [];
    let callCount = 0;
    const authFn = vi.fn(async (
      provider: OAuthClientProvider,
      options: { scope?: string },
    ) => {
      observedScopes.push(options.scope);
      expect(provider.clientMetadata.grant_types).toContain("refresh_token");
      callCount += 1;
      if (callCount === 1) return "REDIRECT" as const;
      await provider.saveTokens?.({
        access_token: "authorized-access",
        refresh_token: "authorized-refresh",
        token_type: "bearer",
      });
      return "AUTHORIZED" as const;
    }) as unknown as typeof auth;
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      fetchFn: vi.fn(),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    await coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect: vi.fn(async () => undefined),
      waitForCode: vi.fn(async () => "authorization-code"),
    });

    expect(observedScopes).toEqual([
      "mcp.read offline_access",
      "mcp.read offline_access",
    ]);
    expect(coordinator.state).toBe("ready");
  });

  it("coalesces concurrent 401s into one rotating refresh grant", async () => {
    const { vault, writes } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      redirectUrl: "http://127.0.0.1:4040/oauth/callback",
      clientInformation: { client_id: "pwragent-client" },
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        token_type: "bearer",
      },
    });
    const authFn = refreshAuth(async (provider) => {
      await provider.saveTokens?.({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "bearer",
      });
      return "AUTHORIZED";
    });
    const fetchFn = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer new-access"
        ? new Response("ok", { status: 200 })
        : new Response("expired", { status: 401 });
    });
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      fetchFn,
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });
    const authorizedFetch = coordinator.authorizedFetch();

    const [first, second] = await Promise.all([
      authorizedFetch("https://mcp.example.com/mcp"),
      authorizedFetch("https://mcp.example.com/mcp"),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(authFn).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tokens).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
    });
    expect(coordinator.state).toBe("ready");
  });

  it("retains the prior refresh token when rotation omits a replacement", async () => {
    const { vault, writes } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      clientInformation: { client_id: "pwragent-client" },
      tokens: {
        access_token: "old-access",
        refresh_token: "keep-refresh",
        token_type: "bearer",
      },
    });
    const authFn = refreshAuth(async (provider) => {
      await provider.saveTokens?.({
        access_token: "new-access",
        token_type: "bearer",
      });
      return "AUTHORIZED";
    });
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      fetchFn: vi.fn(async (_input, init) =>
        new Headers(init?.headers).get("authorization") === "Bearer new-access"
          ? new Response("ok", { status: 200 })
          : new Response("expired", { status: 401 })),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    await coordinator.authorizedFetch()("https://mcp.example.com/mcp");

    expect(writes[0]?.tokens?.refresh_token).toBe("keep-refresh");
  });

  it("turns an invalid refresh grant into explicit reauthorization", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      clientInformation: { client_id: "pwragent-client" },
      tokens: {
        access_token: "expired-access",
        refresh_token: "invalid-refresh",
        token_type: "bearer",
      },
    });
    const coordinator = new McpOAuthSessionCoordinator({
      authFn: refreshAuth(async () => {
        throw new Error("invalid_grant: refresh token is invalid");
      }),
      connectionId: "example",
      fetchFn: vi.fn(async () => new Response("expired", { status: 401 })),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    await expect(
      coordinator.authorizedFetch()("https://mcp.example.com/mcp"),
    ).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
    expect(coordinator.state).toBe("reauthorization_required");
    expect(coordinator.detail).toContain("invalid_grant");
  });

  it("can discard a credential that the protected resource rejected", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      tokens: { access_token: "rejected-access", token_type: "bearer" },
    });
    const onCredentialRejected = vi.fn(async () => undefined);
    const coordinator = new McpOAuthSessionCoordinator({
      connectionId: "example",
      discardRejectedCredentials: true,
      fetchFn: vi.fn(async () => new Response("expired", { status: 401 })),
      onCredentialRejected,
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    await expect(
      coordinator.authorizedFetch()("https://mcp.example.com/mcp"),
    ).rejects.toBeInstanceOf(McpReauthorizationRequiredError);

    expect(vault.delete).toHaveBeenCalledOnce();
    expect(onCredentialRejected).toHaveBeenCalledOnce();
    await expect(coordinator.configured()).resolves.toBe(false);
  });

  it("keeps a newer authorization when an older request returns 401", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      discoveryState: {
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
        },
        resourceMetadata: {
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        },
      },
      tokens: { access_token: "stale-access", token_type: "bearer" },
    });
    let releaseRequest: (() => void) | undefined;
    let requestStarted: (() => void) | undefined;
    const firstRequestStarted = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const firstRequestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let authCall = 0;
    const authFn = vi.fn(async (provider: OAuthClientProvider) => {
      authCall += 1;
      if (authCall === 1) return "REDIRECT" as const;
      await provider.saveTokens?.({
        access_token: "fresh-access",
        token_type: "bearer",
      });
      return "AUTHORIZED" as const;
    }) as unknown as typeof auth;
    let fetchCall = 0;
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      fetchCall += 1;
      if (fetchCall === 1) {
        requestStarted?.();
        await firstRequestReleased;
        return new Response("expired", { status: 401 });
      }
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer fresh-access");
      return new Response("ok", { status: 200 });
    });
    const onCredentialRejected = vi.fn(async () => undefined);
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      discardRejectedCredentials: true,
      fetchFn,
      onCredentialRejected,
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    const pending = coordinator.authorizedFetch()(
      "https://mcp.example.com/mcp",
    );
    await firstRequestStarted;
    await coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect: vi.fn(async () => undefined),
      waitForCode: vi.fn(async () => "authorization-code"),
    });
    releaseRequest?.();

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(vault.delete).not.toHaveBeenCalled();
    expect(onCredentialRejected).not.toHaveBeenCalled();
    await expect(coordinator.configured()).resolves.toBe(true);
  });

  it("requires reauthorization when the rotated access token is also rejected", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      clientInformation: { client_id: "pwragent-client" },
      tokens: {
        access_token: "expired-access",
        refresh_token: "refresh-token",
        token_type: "bearer",
      },
    });
    const coordinator = new McpOAuthSessionCoordinator({
      authFn: refreshAuth(async (provider) => {
        await provider.saveTokens?.({
          access_token: "rejected-access",
          refresh_token: "rotated-refresh",
          token_type: "bearer",
        });
        return "AUTHORIZED";
      }),
      connectionId: "example",
      fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    await expect(
      coordinator.authorizedFetch()("https://mcp.example.com/mcp"),
    ).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
    expect(coordinator.state).toBe("reauthorization_required");
  });

  it("retains credentials while exposing a transient upstream failure", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      tokens: { access_token: "access", token_type: "bearer" },
    });
    const coordinator = new McpOAuthSessionCoordinator({
      connectionId: "example",
      fetchFn: vi.fn(async () => new Response("busy", { status: 503 })),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    const response = await coordinator.authorizedFetch()(
      "https://mcp.example.com/mcp",
    );

    expect(response.status).toBe(503);
    expect(coordinator.state).toBe("temporarily_unavailable");
    await expect(coordinator.configured()).resolves.toBe(true);
  });

  it("does not publish a rotated access token when durable storage fails", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      clientInformation: { client_id: "pwragent-client" },
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        token_type: "bearer",
      },
    });
    vi.mocked(vault.write).mockRejectedValueOnce(new Error("keychain unavailable"));
    const coordinator = new McpOAuthSessionCoordinator({
      authFn: refreshAuth(async (provider) => {
        await provider.saveTokens?.({
          access_token: "memory-only-access",
          refresh_token: "memory-only-refresh",
          token_type: "bearer",
        });
        return "AUTHORIZED";
      }),
      connectionId: "example",
      fetchFn: vi.fn(async () => new Response("expired", { status: 401 })),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    await expect(
      coordinator.authorizedFetch()("https://mcp.example.com/mcp"),
    ).rejects.toThrow("keychain unavailable");
    expect(coordinator.state).toBe("temporarily_unavailable");
  });

  it("does not resurrect a credential revoked during a refresh", async () => {
    const { vault, writes } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      redirectUrl: "http://127.0.0.1:4040/oauth/callback",
      clientInformation: { client_id: "pwragent-client" },
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        token_type: "bearer",
      },
    });
    let started: (() => void) | undefined;
    let release: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const authFn = refreshAuth(async (provider) => {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await provider.saveTokens?.({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "bearer",
      });
      return "AUTHORIZED";
    });
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      fetchFn: vi.fn(async () => new Response("expired", { status: 401 })),
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    const pending = coordinator
      .authorizedFetch()("https://mcp.example.com/mcp")
      .catch(() => undefined);
    await refreshStarted;
    // The operator disconnects while the token POST is still in flight.
    await coordinator.disconnect();
    release?.();
    await pending;

    // The token response landed after the revocation and must not be stored.
    expect(writes).toHaveLength(0);
    expect(await coordinator.configured()).toBe(false);
    expect(coordinator.state).not.toBe("ready");
    expect(vault.delete).toHaveBeenCalled();
  });
  /**
   * A cancel is not a failure.
   *
   * `authorize` reports every rejection as `reauthorization_required`, which
   * is right for a flow that broke. Called off deliberately -- the operator
   * clicked Reauthorize on a working connection, then Stop waiting -- that
   * same path told them a `ready` connection whose credentials were never
   * touched now needs a login.
   */
  it("restores the pre-authorization state when an attempt is called off", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      discoveryState: { authorizationServerUrl: "https://auth.example.com" },
    });
    const authFn = vi.fn(async (
      provider: OAuthClientProvider,
      options: { authorizationCode?: string },
    ) => {
      if (!options.authorizationCode) return "REDIRECT" as const;
      await provider.saveTokens?.({
        access_token: options.authorizationCode,
        token_type: "bearer",
      });
      return "AUTHORIZED" as const;
    }) as unknown as typeof auth;
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    // Get the connection to `ready` the way a working one gets there.
    await coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect: vi.fn(async () => undefined),
      waitForCode: vi.fn(async () => "good-access"),
    });
    expect(coordinator.state).toBe("ready");

    // Reauthorize, then walk away. The wait rejects the way the gateway's
    // `abandon` rejects it, after the attempt has been retired.
    let releaseCode: ((reason: Error) => void) | undefined;
    const attempt = coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4041/oauth/callback"),
      onRedirect: vi.fn(async () => undefined),
      waitForCode: () => new Promise<string>((_resolve, reject) => {
        releaseCode = reject;
      }),
    });
    await vi.waitFor(() => expect(releaseCode).toBeDefined());
    expect(coordinator.state).toBe("connecting");

    coordinator.abandonAuthorization();
    releaseCode?.(new Error("example authorization was cancelled."));

    // The caller still learns its attempt failed...
    await expect(attempt).rejects.toThrow();
    // ...but the connection is exactly where it was, not "Login required".
    expect(coordinator.state).toBe("ready");
    expect(coordinator.detail).toBeUndefined();
    await expect(coordinator.configured()).resolves.toBe(true);
  });

  /**
   * The state snapshot survives the attempt that took it, so a cancel arriving
   * when nothing is in flight would restore the state that preceded the *last*
   * authorization -- knocking a working connection back to `disconnected`.
   */
  it("ignores a cancel when no authorization is in flight", async () => {
    const { vault } = createVault({
      resourceUrl: "https://mcp.example.com/mcp",
      discoveryState: { authorizationServerUrl: "https://auth.example.com" },
    });
    const authFn = vi.fn(async (
      provider: OAuthClientProvider,
      options: { authorizationCode?: string },
    ) => {
      if (!options.authorizationCode) return "REDIRECT" as const;
      await provider.saveTokens?.({
        access_token: options.authorizationCode,
        token_type: "bearer",
      });
      return "AUTHORIZED" as const;
    }) as unknown as typeof auth;
    const coordinator = new McpOAuthSessionCoordinator({
      authFn,
      connectionId: "example",
      serverUrl: new URL("https://mcp.example.com/mcp"),
      vault,
    });

    // Before anything has run: the snapshot is empty, so an unguarded restore
    // would force `disconnected`.
    coordinator.abandonAuthorization();

    await coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4040/oauth/callback"),
      onRedirect: vi.fn(async () => undefined),
      waitForCode: vi.fn(async () => "good-access"),
    });
    expect(coordinator.state).toBe("ready");

    // And after it completed: the snapshot now holds `disconnected`, the state
    // that preceded the authorization that just succeeded. A stray cancel must
    // not put that back.
    coordinator.abandonAuthorization();
    coordinator.abandonAuthorization();
    expect(coordinator.state).toBe("ready");
    await expect(coordinator.configured()).resolves.toBe(true);

    // The attempt counter is untouched, so the next authorization still owns
    // its own state rather than starting out superseded.
    await coordinator.authorize({
      redirectUrl: new URL("http://127.0.0.1:4041/oauth/callback"),
      onRedirect: vi.fn(async () => undefined),
      waitForCode: vi.fn(async () => "second-access"),
    });
    expect(coordinator.state).toBe("ready");
  });
});
