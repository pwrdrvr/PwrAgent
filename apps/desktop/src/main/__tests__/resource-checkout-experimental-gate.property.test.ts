import fc from "fast-check";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolMcpServerLike } from "../agent-tools/agent-tool-mcp-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import {
  createKimiAcpRegistry,
  createOverlayStoreMock,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";

const RESOURCE_CHECKOUT_TOOLS = [
  "resource_checkout_discover",
  "resource_checkout_action",
  "resource_checkout_status",
  "resource_checkout_wait",
  "resource_checkout_handoff",
  "resource_checkout_execute",
] as const;

type CheckoutTool = (typeof RESOURCE_CHECKOUT_TOOLS)[number];

function flattenTools(specs: DynamicToolSpec[]): Array<{ name: string; deferLoading?: boolean }> {
  return specs.flatMap((spec) => (spec.type === "namespace" ? spec.tools : [spec]));
}

/**
 * Rule: Federation/local resource checkout tools are gated by the Experimental
 * flag across every agent surface (Codex dynamic tools + tool search, and the
 * PwrAgent MCP server used by Claude and ACP).
 *
 * - While the flag is off (including the default when no predicate is passed),
 *   zero `resource_checkout_*` tools are advertised or listed, and calling any
 *   of them on a live turn is refused without invoking the checkout handler.
 * - While the flag is on, all six tools are advertised/listed and live calls
 *   reach the checkout handler.
 */
describe("resource checkout experimental gate", () => {
  it("defaults to off when setResourceCheckoutHandler receives no enabled predicate", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(() => registry.close());
    const handler = vi.fn(async () => ({ ok: true }));
    registry.setResourceCheckoutHandler(handler);

    const catalog = registry as unknown as {
      buildCodexParentDynamicTools: (tokenMiser: boolean) => Promise<DynamicToolSpec[]>;
    };
    const codexTools = flattenTools(await catalog.buildCodexParentDynamicTools(false))
      .filter((tool) => tool.name.startsWith("resource_checkout_"));
    expect(codexTools).toHaveLength(0);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "t-default", turnId: "turn-1", turn: { id: "turn-1" } },
      },
    });
    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "t-default",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "resource_checkout_discover",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);
    expect(response).toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("gates Codex discovery and dynamic tool dispatch across arbitrary toggle sequences", async () => {
    let enabled = false;
    let discovery = true;
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolveCodexToolDiscovery: () => discovery,
    });
    onTestFinished(() => registry.close());

    const handler = vi.fn(async () => []);
    registry.setResourceCheckoutHandler(handler, undefined, () => enabled);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "t-codex", turnId: "turn-codex", turn: { id: "turn-codex" } },
      },
    });

    const catalog = registry as unknown as {
      buildCodexParentDynamicTools: (tokenMiser: boolean) => Promise<DynamicToolSpec[]>;
    };

    const stepArb = fc.record({
      nextEnabled: fc.boolean(),
      nextDiscovery: fc.boolean(),
      tool: fc.constantFrom<CheckoutTool>(...RESOURCE_CHECKOUT_TOOLS),
    });

    let callSeq = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 8 }),
        async (steps) => {
          for (const step of steps) {
            enabled = step.nextEnabled;
            discovery = step.nextDiscovery;
            handler.mockClear();

            const advertised = flattenTools(await catalog.buildCodexParentDynamicTools(false))
              .filter((tool) => tool.name.startsWith("resource_checkout_"));
            expect(advertised).toHaveLength(enabled ? RESOURCE_CHECKOUT_TOOLS.length : 0);
            expect(advertised.every((tool) => tool.deferLoading === true)).toBe(true);

            const id = `codex-call-${++callSeq}`;
            const toolToCall = enabled ? "resource_checkout_discover" : step.tool;
            const response = await codexClient.emitRequest({
              method: "item/tool/call",
              params: {
                threadId: "t-codex",
                turnId: "turn-codex",
                callId: id,
                requestId: id,
                namespace: "pwragent",
                tool: toolToCall,
                arguments: {},
              },
            } as AppServerPendingRequestNotification);

            if (enabled) {
              expect(response).toMatchObject({ success: true });
              expect(handler).toHaveBeenCalledTimes(1);
            } else {
              expect(response).toMatchObject({ success: false });
              expect(handler).not.toHaveBeenCalled();
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("gates Claude and ACP MCP listing and tool calls across arbitrary toggle sequences", async () => {
    let enabled = false;
    const backend = "acp:kimi" as const;
    const threadId = "kimi-session-1";
    const { registry } = createKimiAcpRegistry({
      startPrompt: vi.fn((params) => ({ sessionId: params.sessionId, turnId: params.turnId! })),
    });
    const handler = vi.fn(async () => []);
    registry.setResourceCheckoutHandler(handler, undefined, () => enabled);

    const client = new McpClient({ name: "acp-checkout-gate-fixture", version: "1.0.0" });
    onTestFinished(async () => {
      await client.close();
      await registry.close();
    });

    await registry.startThread({ backend, cwd: "/repo", executionMode: "default" });
    await registry.startTurn({ backend, threadId, input: [{ type: "text", text: "Check resources" }] });
    const server = (registry as unknown as { claudeAgentToolMcpServer: AgentToolMcpServerLike })
      .claudeAgentToolMcpServer;
    const registration = await server.registerClient({ backend, threadId });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(registration.server.url), {
        requestInit: {
          headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])),
        },
      }),
    );

    const stepArb = fc.record({
      nextEnabled: fc.boolean(),
      tool: fc.constantFrom<CheckoutTool>(...RESOURCE_CHECKOUT_TOOLS),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 6 }),
        async (steps) => {
          for (const step of steps) {
            enabled = step.nextEnabled;
            handler.mockClear();

            const listed = (await client.listTools()).tools
              .map(({ name }) => name)
              .filter((name) => name.startsWith("resource_checkout_"));
            expect(listed).toHaveLength(enabled ? RESOURCE_CHECKOUT_TOOLS.length : 0);

            if (enabled) {
              const result = await client.callTool({
                name: "resource_checkout_discover",
                arguments: {},
              });
              expect(result.isError).not.toBe(true);
              expect(handler).toHaveBeenCalledTimes(1);
            } else {
              let refused = false;
              try {
                const result = await client.callTool({ name: step.tool, arguments: {} });
                refused = result.isError === true;
              } catch {
                refused = true;
              }
              expect(refused).toBe(true);
              expect(handler).not.toHaveBeenCalled();
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
