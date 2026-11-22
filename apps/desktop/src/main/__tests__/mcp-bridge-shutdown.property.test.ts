import fs from "node:fs";
import os from "node:os";
import type { Server } from "node:net";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { sandboxerStub } from "./helpers/sandboxer-stub";

const fixture = vi.hoisted(() => ({
  pause: undefined as ((socketPath: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (file: Parameters<typeof actual.chmod>[0], mode: Parameters<typeof actual.chmod>[1]) => {
      if (typeof file === "string" && path.basename(file) === "bridge.sock") await fixture.pause?.(file);
      return await actual.chmod(file, mode);
    },
  };
});

it.skipIf(process.platform === "win32")("joins bridge startup before reporting shutdown complete", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (turns) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-bridge-close-"));
    const service = new McpConnectionGatewayService({
      sandboxer: sandboxerStub(),
      leaseManager: null,
      settings: {
        resolvePwrGitMcpCredential: async () => undefined,
        clearPwrGitMcpCredential: async () => undefined,
        resolvePwrSnapMcpCredential: async () => undefined,
        savePwrSnapMcpCredential: async () => undefined,
        clearPwrSnapMcpCredential: async () => undefined,
        resolveMcpConnectionCredentials: async () => undefined,
        saveMcpConnectionCredentials: async () => undefined,
        clearMcpConnectionCredentials: async () => undefined,
      },
      registry: new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") }),
    });
    const entered = Promise.withResolvers<string>();
    const resume = Promise.withResolvers<void>();
    fixture.pause = (socketPath) => {
      entered.resolve(socketPath);
      return resume.promise;
    };
    try {
      const start = service.start();
      const socketPath = await entered.promise;
      const shutdown = service.close();
      for (let turn = 0; turn < turns; turn++) await yieldTurn();
      resume.resolve();
      await Promise.all([start, shutdown]);
      // Removing a Unix socket's directory does not close the listening handle.
      const listener = (service as unknown as { bridgeServer?: Server }).bridgeServer;
      expect(listener?.listening ?? false).toBe(false);
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      resume.resolve();
      fixture.pause = undefined;
      await service.close();
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }), { numRuns: 10 });
});
