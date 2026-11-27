import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";

it("uses the creation-time transport for each new Codex thread regardless of later profile settings", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (enabledAtCreation, enabledAtTurn) => {
    let enabled = enabledAtCreation;
    const client = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      serverCapabilities: { codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" } },
    });
    const overlayStore = createOverlayStoreMock();
    const bindThread = vi.fn();
    const registerClient = vi.fn(async (context: { threadId?: string }) => ({
      server: {
        name: "pwragent",
        type: "http" as const,
        url: context.threadId ? "http://127.0.0.1:9002/mcp" : "http://127.0.0.1:9001/mcp",
        headers: [],
      },
      bindThread,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient: client,
      overlayStore,
      agentToolMcpServer: { registerClient, close: vi.fn(async () => {}) },
      resolveCodexAgentToolsMcp: () => enabled,
      createScratchProjectDirectory: async () => "/tmp/pwragent-codex-mcp",
    });
    try {
      const { threadId } = await registry.startThread({ backend: "codex" });
      const initialServers = client.lastStartThreadParams?.config?.mcp_servers;
      const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId });
      expect(overlay?.codexAgentToolsMcp === true).toBe(enabledAtCreation);
      expect(Boolean(client.lastStartThreadParams?.dynamicTools)).toBe(!enabledAtCreation);
      expect(initialServers).toEqual(enabledAtCreation ? {
        pwragent_apps: { enabled: true, required: true, url: "http://127.0.0.1:9001/mcp", http_headers: {} },
      } : undefined);
      expect(bindThread.mock.calls).toEqual(enabledAtCreation ? [[threadId]] : []);

      enabled = enabledAtTurn;
      await registry.startTurn({ backend: "codex", threadId, input: [{ type: "text", text: "Hello" }] });
      const turnServers = client.lastStartTurnParams?.config?.mcp_servers;
      expect(turnServers).toEqual(enabledAtCreation ? {
        pwragent_apps: { enabled: true, required: true, url: "http://127.0.0.1:9002/mcp", http_headers: {} },
      } : undefined);
      expect(Boolean(client.lastStartTurnParams?.dynamicTools)).toBe(!enabledAtCreation);
      expect(registerClient.mock.calls.map(([context]) => context.threadId))
        .toEqual(enabledAtCreation ? [undefined, threadId] : []);
    } finally {
      await registry.close();
    }
  }), { examples: [[true, false], [false, true], [false, false], [true, true]], numRuns: 4 });
});
