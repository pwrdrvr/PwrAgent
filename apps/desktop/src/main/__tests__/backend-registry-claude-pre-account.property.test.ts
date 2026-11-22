import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { expect, it, vi } from "vitest";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";

// A pending SDK read can end with EOF or reject. In both cases, a turn
// that never got init must deliver its terminal and retire within shutdown.
it.each(["EOF", "a rejected read"] as const)("retires a Claude turn when its first SDK read ends with %s", async (exit) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-stream-exit-"));
  const read = Promise.withResolvers<IteratorResult<SDKMessage>>();
  const eof = () => read.resolve({ done: true, value: undefined });
  const providerError = new Error("The Claude SDK stream disconnected.");
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({}),
    overlayStore: createOverlayStoreMock(),
    claudeBackendOptions: {
      store: new ClaudeSessionStore(path.join(cwd, "sessions")),
      inspectInstallation: async () => ({ executable: "/fixture/claude", version: "2.1.330", authStatus: "signed-in" }),
      discoverModels: async () => [],
      query: () => ({
        [Symbol.asyncIterator]() { return this; },
        next: () => read.promise,
        initializationResult: async () => ({ mcp_servers_applied: true }),
        close: eof,
      }) as unknown as Query,
    },
  });
  const terminalReady = Promise.withResolvers<void>();
  const deliverTerminal = Promise.withResolvers<void>();
  const ingress = registry as unknown as { emit(event: AgentEvent): Promise<void> };
  const emit = ingress.emit.bind(ingress);
  vi.spyOn(ingress, "emit").mockImplementation(async (event) => {
    if (event.backend === "claude" && event.notification.method === "turn/failed") {
      terminalReady.resolve();
      await deliverTerminal.promise;
    }
    await emit(event);
  });
  const observed = vi.fn();
  registry.onEvent((event) => {
    if (event.backend === "claude" && event.notification.method === "turn/failed") observed(event);
  });

  try {
    const { threadId } = await registry.startThread({ backend: "claude", cwd, executionMode: "default" });
    const turn = await registry.startTurn({
      backend: "claude", threadId, input: [{ type: "text", text: "Start" }],
    });
    if (exit === "EOF") eof();
    else read.reject(providerError);
    // Claude has exited on its own. Hold its terminal at the registry
    // boundary until shutdown has taken the snapshot of active turns.
    await terminalReady.promise;
    expect(registry.getActiveTurnForThread(turn)).toEqual(turn);
    const shutdown = registry.stopRunningTurnsForShutdown();
    deliverTerminal.resolve();
    await shutdown;

    expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      backend: "claude",
      notification: expect.objectContaining({
        params: expect.objectContaining({
          threadId,
          turnId: turn.turnId,
          turn: expect.objectContaining({
            status: "failed",
            error: { message: exit === "EOF" ? "Claude exited before completing the turn." : providerError.message },
          }),
        }),
      }),
    }));
    expect(registry.getActiveTurnForThread(turn)).toBeUndefined();
  } finally {
    eof();
    deliverTerminal.resolve();
    await registry.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
