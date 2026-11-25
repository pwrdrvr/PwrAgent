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
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { AgentToolHttpMcpServerConfig } from "../agent-tools/agent-tool-mcp-server";
import { createResourceCheckoutToolHandler } from "../agent-tools/pwragent-resource-checkout-agent-tools";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import {
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createOverlayStoreMock,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";

const RESOURCE_CHECKOUT_TOOLS = [
  "resource_checkout_discover",
  "resource_checkout_acquire",
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
 * - While the flag is on, all checkout tools are advertised/listed and live calls
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

  it("gates the MCP registration delivered to ACP across flag and checkout changes", async () => {
    let enabled = false;
    let hasCheckout = false;
    const backend = "acp:kimi" as const;
    const threadId = "kimi-session-1";
    const client = new McpClient({ name: "acp-checkout-gate-fixture", version: "1.0.0" });
    const promptStarted = Promise.withResolvers<void>();
    const finishPrompt = Promise.withResolvers<void>();
    const transport = new class extends FakeAcpAgentTransport {
      override async request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
        if (method === "session/new") {
          // Connect as the provider receives the registration, before it
          // assigns the session ID that the registry must bind it to.
          const servers = (params?.mcpServers ?? []) as AgentToolHttpMcpServerConfig[];
          const server = servers.find(({ name, type }) => name === "pwragent" && type === "http");
          if (!server) throw new Error("ACP session/new did not receive the PwrAgent HTTP MCP registration.");
          const headers = Object.fromEntries(server.headers.map(({ name, value }) => [name, value]));
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
        }
        if (method === "session/prompt") {
          promptStarted.resolve();
          await finishPrompt.promise;
          this.emitSessionUpdate(threadId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Done." },
          });
          return { stopReason: "end_turn" };
        }
        return await super.request(method, params, timeoutMs);
      }
    }({
      initialize: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } },
      "session/new": { sessionId: threadId },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([createKimiAgentRecord(backend)]),
      acpSessionStore: createAcpSessionStoreMock([]),
      createAcpTransport: () => transport,
      threadTitleGenerationService: null,
    });
    onTestFinished(async () => {
      finishPrompt.resolve();
      try {
        await client.close();
      } finally {
        await registry.close();
      }
    });

    const handler = vi.fn(async () => []);
    registry.setResourceCheckoutHandler(
      handler, undefined, () => enabled,
      (ownerBackend, ownerThreadId) => hasCheckout && ownerBackend === backend && ownerThreadId === threadId,
    );

    const thread = await registry.startThread({ backend, cwd: "/repo", executionMode: "default" });
    expect(thread.threadId).toBe(threadId);
    const listCheckoutTools = async () => (await client.listTools()).tools
      .map(({ name }) => name)
      .filter((name) => name.startsWith("resource_checkout_"));
    const discover = async () => await client.callTool({ name: "resource_checkout_discover", arguments: {} });
    expect(await listCheckoutTools()).toEqual([]);

    enabled = true;
    expect(await discover()).toMatchObject({ isError: true });
    expect(handler).not.toHaveBeenCalled();

    const { turnId } = await registry.startTurn({
      backend, threadId, input: [{ type: "text", text: "Check resources" }],
    });
    await promptStarted.promise;
    const context = expect.objectContaining({ backend, threadId, turnId });
    const allTools = [...RESOURCE_CHECKOUT_TOOLS].sort();
    expect(await listCheckoutTools()).toEqual(allTools);
    expect((await discover()).isError).not.toBe(true);
    expect(handler).toHaveBeenCalledExactlyOnceWith("resource_checkout_discover", {}, context);

    // Disabling the flag hides the catalog immediately for a nonholder on this connection.
    enabled = false;
    expect(await listCheckoutTools()).toEqual([]);
    handler.mockClear();
    expect(await discover()).toMatchObject({ isError: true });
    expect(handler).not.toHaveBeenCalled();

    enabled = true;
    expect(await listCheckoutTools()).toEqual(allTools);

    // The same client can still call cleanup tools from its previous listing.
    hasCheckout = true;
    expect(await listCheckoutTools()).toEqual(allTools);
    enabled = false;
    const resourceId = "machine:fixture:cpu";
    const status = { resourceId, idempotencyKey: "request" };
    const request = {
      action: { kind: "request", resourceId, idempotencyKey: "new", purpose: "Fixture work", expectedDurationMs: 5_000 },
    };
    for (const ownsCheckout of [true, false]) {
      hasCheckout = ownsCheckout;
      expect(await listCheckoutTools()).toEqual(ownsCheckout ? CHECKOUT_CLEANUP_TOOLS : []);
      handler.mockClear();
      expect((await client.callTool({ name: "resource_checkout_status", arguments: status })).isError).not.toBe(true);
      expect(handler).toHaveBeenCalledExactlyOnceWith("resource_checkout_status", status, context);

      handler.mockClear();
      for (const name of RESOURCE_CHECKOUT_TOOLS.filter((tool) => tool !== "resource_checkout_status")) {
        const args = name === "resource_checkout_action" ? request : {};
        expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true });
      }
      expect(handler).not.toHaveBeenCalled();

      if (ownsCheckout) {
        for (const action of [
          { kind: "release", resourceId, idempotencyKey: "release", allocationId: "grant", generation: 1 },
          { kind: "cancel_request", resourceId, idempotencyKey: "cancel", queueEntryId: "queued" },
        ]) {
          handler.mockClear();
          const args = { action };
          expect((await client.callTool({ name: "resource_checkout_action", arguments: args })).isError).not.toBe(true);
          expect(handler).toHaveBeenCalledExactlyOnceWith("resource_checkout_action", args, context);
        }
      }
    }

    enabled = true;
    expect(await listCheckoutTools()).toEqual(allTools);
    handler.mockClear();
    expect((await discover()).isError).not.toBe(true);
    expect(handler).toHaveBeenCalledExactlyOnceWith("resource_checkout_discover", {}, context);

    const turnFinished = Promise.withResolvers<string>();
    const unsubscribe = registry.onEvent((event) => {
      const { notification } = event;
      if (event.backend === backend
        && (notification.method === "turn/completed" || notification.method === "turn/failed" || notification.method === "turn/cancelled")
        && notification.params.threadId === threadId && notification.params.turnId === turnId) {
        turnFinished.resolve(notification.method);
      }
    });
    onTestFinished(unsubscribe);
    finishPrompt.resolve();
    expect(await turnFinished.promise).toBe("turn/completed");
    handler.mockClear();
    expect(await discover()).toMatchObject({ isError: true });
    expect(handler).not.toHaveBeenCalled();
  });
});
