import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import type { AgentToolMcpServerLike } from "../agent-tools/agent-tool-mcp-server";
import { createResourceCheckoutToolHandler } from "../agent-tools/pwragent-resource-checkout-agent-tools";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
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

const CHECKOUT_CLEANUP_TOOLS = ["resource_checkout_action", "resource_checkout_status"];
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
 *   threads without outstanding checkouts see no tools. Cleanup still reaches
 *   the authority through a live turn, including with a stale tool catalog.
 * - While the flag is on, all six tools are advertised/listed and live calls
 *   reach the checkout handler. Without tool discovery, the Codex tools load
 *   eagerly so a provider without search can use them.
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
            expect(advertised.every((tool) => tool.deferLoading === discovery)).toBe(true);

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
                arguments: toolToCall === "resource_checkout_status"
                  ? { resourceId: "machine:fixture:cpu", idempotencyKey: "request" }
                  : {},
              },
            } as AppServerPendingRequestNotification);

            if (enabled || toolToCall === "resource_checkout_status") {
              expect(response).toMatchObject({ success: true });
              expect(handler).toHaveBeenCalledTimes(1);
            } else {
              expect(response).toMatchObject({ success: false });
              expect(handler).not.toHaveBeenCalled();
            }
          }
        },
      ),
      {
        numRuns: 25,
        examples: [[[{ nextEnabled: true, nextDiscovery: false, tool: "resource_checkout_discover" }]]],
      },
    );
  });

  it("lets disabled Codex threads clean up through a stale action tool", async () => {
    let enabled = true;
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(() => registry.close());
    const handler = vi.fn(async () => ({ outcome: "accepted" }));
    registry.setResourceCheckoutHandler(handler, undefined, () => enabled);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "holder", turnId: "turn-1", turn: { id: "turn-1" } },
      },
    });
    enabled = false;

    let callSeq = 0;
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("release", "cancel_request", "request", "extend", "register_definition"),
      fc.uuid(),
      async (kind, idempotencyKey) => {
        handler.mockClear();
        const callId = `cleanup-${++callSeq}`;
        const args = {
          action: {
            kind, idempotencyKey, resourceId: "machine:fixture:cpu", allocationId: "allocation",
            generation: 1, queueEntryId: "queue",
          },
        };
        const response = await codexClient.emitRequest({
          method: "item/tool/call",
          params: {
            threadId: "holder", turnId: "turn-1", callId, requestId: callId,
            namespace: "pwragent", tool: "resource_checkout_action", arguments: args,
          },
        } as AppServerPendingRequestNotification);
        if (kind === "release" || kind === "cancel_request") {
          expect(response).toMatchObject({ success: true });
          expect(handler).toHaveBeenCalledExactlyOnceWith("resource_checkout_action", args, expect.objectContaining({
            backend: "codex", threadId: "holder", turnId: "turn-1",
          }));
        } else {
          expect(response).toMatchObject({ success: false });
          expect(handler).not.toHaveBeenCalled();
        }
      },
    ), { numRuns: 25, examples: [["release", "00000000-0000-4000-8000-000000000000"]] });
  });

  it("keeps a held checkout discoverable and releasable by its owner after a tool refresh", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-gate-"));
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "fixture", instanceLabel: "Fixture", profile: "default", machineId: "fixture" },
      machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), "fixture"),
      bindings: [], now: () => 1, requestPeer: async () => { throw new Error("No peers"); }, warn: () => {},
    });
    onTestFinished(async () => {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    });

    let enabled = true;
    const codexClient = new MockBackendClient({
      threads: [],
      serverCapabilities: { codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" } },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolveCodexToolDiscovery: () => false,
    });
    onTestFinished(() => registry.close());
    registry.setResourceCheckoutHandler(
      createResourceCheckoutToolHandler(service), undefined, () => enabled,
      (backend, threadId) => service.hasAgentCheckoutToCleanUp(backend, threadId),
    );

    const { threadId: holder } = await registry.startThread({ backend: "codex", cwd: root });
    const checkoutTools = (specs: unknown) => flattenTools(specs as DynamicToolSpec[])
      .filter((tool) => tool.name.startsWith("resource_checkout_"));
    const initialTools = checkoutTools(codexClient.lastStartThreadParams?.dynamicTools);
    expect(initialTools.map(({ name }) => name)).toEqual(RESOURCE_CHECKOUT_TOOLS);
    expect(initialTools.every(({ deferLoading }) => deferLoading === false)).toBe(true);

    const resourceId = "machine:fixture:cpu";
    const checkout = await service.perform({
      kind: "request", resourceId, idempotencyKey: "request", expectedDurationMs: 5_000, purpose: "Fixture work",
    }, service.threadActor("codex", holder));
    if (checkout.outcome !== "granted") throw new Error("Expected a granted checkout.");

    enabled = false;
    const { turnId } = await registry.startTurn({ backend: "codex", threadId: holder, input: [{ type: "text", text: "Release the checkout." }] });
    const cleanupTools = checkoutTools(codexClient.lastStartTurnParams?.dynamicTools);
    expect(cleanupTools.map(({ name }) => name)).toEqual(CHECKOUT_CLEANUP_TOOLS);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: holder, turnId, turn: { id: turnId } },
      },
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "other-thread", turnId: "other-turn", turn: { id: "other-turn" } },
      },
    });
    const release = (threadId: string, id: string) => codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId, turnId: id, callId: threadId, requestId: threadId,
        namespace: "pwragent", tool: "resource_checkout_action",
        arguments: { action: {
          kind: "release", resourceId, idempotencyKey: "release",
          allocationId: checkout.allocationId, generation: checkout.generation,
        } },
      },
    } as AppServerPendingRequestNotification);

    const denied = await release("other-thread", "other-turn");
    expect(denied).toMatchObject({
      contentItems: [{ type: "inputText", text: expect.stringContaining("not_authorized") }],
    });
    expect(await service.status(service.threadActor("codex", holder), resourceId, "request"))
      .toMatchObject({ state: "granted" });

    expect(await release(holder, turnId)).toMatchObject({
      contentItems: [{ type: "inputText", text: expect.stringContaining('"outcome": "accepted"') }],
    });
    expect(await service.status(service.threadActor("codex", holder), resourceId, "request"))
      .toMatchObject({ state: "ended" });
  });

  it("gates Claude and ACP MCP listing and tool calls across arbitrary toggle sequences", async () => {
    let enabled = false;
    let hasCheckout = false;
    const backend = "acp:kimi" as const;
    const threadId = "kimi-session-1";
    const { registry } = createKimiAcpRegistry({
      startPrompt: vi.fn((params) => ({ sessionId: params.sessionId, turnId: params.turnId! })),
    });
    const handler = vi.fn(async () => []);
    registry.setResourceCheckoutHandler(
      handler, undefined, () => enabled,
      (ownerBackend, ownerThreadId) => hasCheckout && ownerBackend === backend && ownerThreadId === threadId,
    );

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
      hasCheckout: fc.boolean(),
      tool: fc.constantFrom<CheckoutTool>(...RESOURCE_CHECKOUT_TOOLS),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 6 }),
        async (steps) => {
          for (const step of steps) {
            enabled = step.nextEnabled;
            hasCheckout = step.hasCheckout;
            handler.mockClear();

            const listed = (await client.listTools()).tools
              .map(({ name }) => name)
              .filter((name) => name.startsWith("resource_checkout_"));
            expect(listed).toEqual(enabled ? [...RESOURCE_CHECKOUT_TOOLS].sort()
              : hasCheckout ? CHECKOUT_CLEANUP_TOOLS : []);

            if (enabled) {
              const result = await client.callTool({
                name: "resource_checkout_discover",
                arguments: {},
              });
              expect(result.isError).not.toBe(true);
              expect(handler).toHaveBeenCalledTimes(1);
            } else if (step.tool === "resource_checkout_status" || (hasCheckout && step.tool === "resource_checkout_action")) {
              const args = step.tool === "resource_checkout_status"
                ? { resourceId: "machine:fixture:cpu", idempotencyKey: "request" }
                : { action: { kind: "release", resourceId: "machine:fixture:cpu", allocationId: "grant",
                    generation: 1, idempotencyKey: "release" } };
              const result = await client.callTool({ name: step.tool, arguments: args });
              expect(result.isError).not.toBe(true);
              expect(handler).toHaveBeenCalledExactlyOnceWith(step.tool, args, expect.objectContaining({ backend, threadId }));
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
