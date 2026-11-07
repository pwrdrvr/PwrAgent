import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  McpConnectionGatewayService,
  type McpConnectionGatewayServiceOptions,
} from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { sandboxerStub } from "./helpers/sandboxer-stub";

describe("PwrSnap authorization rejection property", () => {
  it("never infers operator revocation from a 401 body and never reuses the rejected credential", async () => {
    // A generic HTTP rejection is not evidence of who invalidated the grant.
    // Generate opaque server bodies; the credential store is the availability oracle.
    await fc.assert(fc.asyncProperty(fc.string({ maxLength: 100 }), async (body) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwrsnap-rejection-property-"));
      let credential: string | undefined = JSON.stringify({
        clientInformation: { client_id: "fixture-client" },
        tokens: { access_token: "fixture-rejected-access", token_type: "bearer" },
      });
      let envelope: string | undefined;
      const settings: NonNullable<McpConnectionGatewayServiceOptions["settings"]> = {
        resolvePwrSnapMcpCredential: async () => credential,
        clearPwrSnapMcpCredential: async () => { credential = undefined; },
        savePwrSnapMcpCredential: async (value) => { credential = value; },
        resolveMcpConnectionCredentials: async () => envelope,
        saveMcpConnectionCredentials: async (value) => { envelope = value; },
        clearMcpConnectionCredentials: async () => { envelope = undefined; },
        resolvePwrGitMcpCredential: async () => undefined,
        clearPwrGitMcpCredential: async () => undefined,
      };
      const fetchFn = vi.fn(async () => new Response(body, { status: 401 }));
      const service = new McpConnectionGatewayService({
        registry: new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") }),
        settings,
        sandboxer: sandboxerStub(),
        leaseManager: null,
        fetchFn,
        resolveInstallPaths: () => [],
      });
      try {
        const failure = await service.listConnectionTools({ connectionId: "pwrsnap" })
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/rejected/);
        expect((failure as Error).message).not.toMatch(/revok/i);
        expect(credential).toBeUndefined();
        expect(envelope).toBeUndefined();
        await expect(service.readStatus()).resolves.toMatchObject({ configured: false });
        const requests = fetchFn.mock.calls.length;
        await expect(service.listConnectionTools({ connectionId: "pwrsnap" }))
          .rejects.toThrow(/rejected/);
        expect(fetchFn).toHaveBeenCalledTimes(requests);
      } finally {
        await service.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }), { numRuns: 25 });
  });
});
