import { describe, expect, it, vi } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  McpOAuthSessionCoordinator,
  McpReauthorizationRequiredError,
} from "../mcp-connections/mcp-oauth-session-coordinator";
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
});
