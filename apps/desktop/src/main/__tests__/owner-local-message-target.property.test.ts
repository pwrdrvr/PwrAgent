import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
  AppServerThreadSummary,
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
  ThreadTodoMessageTarget,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import * as appState from "../state/app-state";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import type { PwrAgentFederatedThreadMessageHandler } from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import { getThreadTodoService, installThreadTodoRuntime, resetThreadTodoServiceForTests } from "../thread-todos/thread-todo-runtime";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// The reported case: viewer M5 opens a card owned by M2 and sends it to an
// M2 thread. The target reaches M2 naming M2's own instance id. M2 must
// deliver it locally; routing it to a "peer" with its own id failed with
// "Federation instance pwr_… is not enrolled".

type Internals = {
  threadTodoHandler: PwrAgentThreadTodoHandler;
  performThreadTurnControlWithFallback(
    request: PwrAgentThreadOrchestrationRequest<"steer_thread">,
  ): Promise<PwrAgentThreadOrchestrationResponse>;
};

type Fixture = {
  registry: DesktopBackendRegistry;
  db: ReturnType<typeof openInMemoryStateDb>;
  /** Every federated send, by the instance it was routed to, or "discover". */
  remoteSends: string[];
  /** Every federated read, search or mutation, the same way. */
  remoteReads: string[];
  submit: ReturnType<typeof vi.spyOn>;
};

/**
 * The owner's federation as a model: the peers it has enrolled. Its own id is
 * never one of them, which is exactly what the federation runtime reports.
 */
async function withOwner(
  owner: { localInstanceId: string; peers: readonly string[] },
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const db = openInMemoryStateDb();
  const target: AppServerThreadSummary = {
    id: "target", source: "codex", title: "M2 destination", titleSource: "explicit",
    linkedDirectories: [], threadStatus: "notLoaded",
  };
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      onNotification: () => () => {}, onPendingRequest: () => () => {},
      listThreads: async (params: { archived?: boolean }) => params.archived === true ? [] : [target],
      readConfiguredMcpServerNames: async () => [],
    } as never,
    overlayStore: new SqliteOverlayStore(db), threadTitleGenerationService: null,
  });
  const remoteSends: string[] = [];
  const remoteReads: string[] = [];
  /** A peer reports "elsewhere" when asked to discover it. */
  const enrolled = (instanceId: string | undefined, threadId: string, log: string[]): string | undefined => {
    log.push(instanceId ?? "discover");
    if (!instanceId) return threadId === "elsewhere" ? owner.peers[0] : undefined;
    if (!owner.peers.includes(instanceId)) {
      throw new Error(`Federation instance ${instanceId}, the known owner of thread ${threadId}, is not enrolled.`);
    }
    return instanceId;
  };
  const remote: PwrAgentFederatedThreadMessageHandler = async (request) => {
    if (!request.instanceId && request.resolutionMode !== "discover_only") return undefined;
    const peer = enrolled(request.instanceId, request.threadId, remoteSends);
    if (!peer) return undefined;
    return {
      backend: request.backend, threadId: request.threadId, turnId: "remote-turn",
      instanceId: peer, instanceLabel: peer, title: "Peer thread",
    };
  };
  registry.setFederatedThreadMessageHandler(remote);
  registry.setFederatedThreadInspectionHandler(async (request) => {
    const peer = enrolled(request.instanceId, request.threadId, remoteReads);
    if (!peer) return undefined;
    return {
      instanceId: peer, instanceLabel: peer,
      thread: { id: request.threadId, title: "Peer thread", titleSource: "explicit", source: "codex", linkedDirectories: [] },
      read: { backend: "codex", fetchedAt: 1, threadId: request.threadId, replay: {
        entries: [], messages: [], threadStatus: "notLoaded",
        pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
    };
  });
  registry.setFederatedThreadMutationHandler(async (request) => {
    enrolled(request.instanceId, request.threadId, remoteReads);
    return undefined;
  });
  registry.setPwrAgentFederationHandler(async (request) => {
    if (request.operation !== "search_federation_threads") throw new Error(`Unexpected ${request.operation}`);
    const args = request.args as { instanceId?: string };
    enrolled(args.instanceId, "search", remoteReads);
    return { ok: true, data: { results: [], unavailableInstances: [] } } as never;
  });
  registry.setFederatedThreadControlHandler(async (request) => {
    if (!request.instanceId) return undefined;
    remoteSends.push(request.instanceId);
    throw new Error(`Federation instance ${request.instanceId} is not enrolled.`);
  });
  registry.setLocalFederationInstanceId(() => owner.localInstanceId);
  const submit = vi.spyOn(registry, "submitTurn").mockImplementation(async (turn) => ({
    status: "queued", entry: { ...turn, id: "queued", createdAt: 1 }, position: 1,
  }) as Awaited<ReturnType<DesktopBackendRegistry["submitTurn"]>>);
  try {
    await run({ registry, db, remoteSends, remoteReads, submit });
  } finally {
    resetThreadTodoServiceForTests();
    await registry.close();
    vi.restoreAllMocks();
    db.close();
  }
}

function installTodos(fixture: Fixture): PwrAgentThreadTodoHandler {
  vi.spyOn(appState, "getAppStateDb").mockReturnValue(fixture.db);
  installThreadTodoRuntime({
    registry: fixture.registry, broadcast: () => {}, listProjects: async () => [], readDefaultMergeMethod: () => "squash",
    feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} },
  });
  return (fixture.registry as unknown as Internals).threadTodoHandler;
}

const instanceId = fc.uuid().map((id) => `pwr_${id}`);

/** An owner, its enrolled peers, and how a target names one of the machines. */
const scenario = fc
  .tuple(instanceId, fc.uniqueArray(instanceId, { minLength: 1, maxLength: 3 }))
  .filter(([local, peers]) => !peers.includes(local))
  .chain(([localInstanceId, peers]) => fc.record({
    localInstanceId: fc.constant(localInstanceId),
    peers: fc.constant(peers),
    named: fc.oneof(
      fc.constant(undefined),
      fc.constant(localInstanceId),
      fc.constant(` ${localInstanceId} `),
      fc.constantFrom(...peers),
    ),
  }));

/** The oracle: where a send must go, decided only by identity. */
function expectedRoute(local: string, named: string | undefined): "local" | string {
  const trimmed = named?.trim();
  return !trimmed || trimmed === local ? "local" : trimmed;
}

function messageTarget(named: string | undefined): ThreadTodoMessageTarget {
  return {
    backend: "codex", threadId: "target", title: "M2 destination",
    ...(named ? { instanceId: named, instanceLabel: "M2" } : {}),
  };
}

describe("owner-local to-do message targets", () => {
  // Rule: a target naming the owner's own instance is the owner's local
  // thread. Only a different, enrolled instance is a federated send.
  it("routes a card's send by the destination's owner, never to this instance as a peer", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        await fixture.registry.sendThreadTodoMessage({
          sourceBackend: "codex", sourceThreadId: "sender", target: messageTarget(named),
          prompt: "Pick up the shutdown evidence", todo: { id: "todo", title: "Send evidence" },
        });
        const route = expectedRoute(localInstanceId, named);
        expect(fixture.remoteSends).toEqual(route === "local" ? [] : [route]);
        expect(fixture.submit).toHaveBeenCalledTimes(route === "local" ? 1 : 0);
        expect(fixture.remoteSends).not.toContain(localInstanceId);
      })), { numRuns: 40 });
  });

  // The reported path end to end: the viewer's runAction carries the M2
  // thread as an M2-named messageTarget, and the owner runs the card.
  it("completes a viewer's Send request to a thread the card's owner owns", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const handler = installTodos(fixture);
        const { todo } = await handler.add({ backend: "codex", threadId: "sender" }, {
          title: "Hand off the evidence",
          action: { type: "start_thread", prompt: "Pick up the shutdown evidence" },
        });
        const ran = await getThreadTodoService().runAction(todo.id, { messageTarget: messageTarget(named) });
        expect(ran).toMatchObject({ id: todo.id, status: "done" });
        expect(ran.error).toBeUndefined();
        const route = expectedRoute(localInstanceId, named);
        expect(fixture.remoteSends).toEqual(route === "local" ? [] : [route]);
        expect(fixture.submit).toHaveBeenCalledTimes(route === "local" ? 1 : 0);
      })), { numRuns: 25 });
  });

  it("raises a card naming this owner's thread as this owner's own", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const located = await fixture.registry.locateThreadTodoMessageTarget(
          { backend: "codex", threadId: "sender" }, messageTarget(named),
        );
        const route = expectedRoute(localInstanceId, named);
        if (route === "local") {
          expect(located).not.toHaveProperty("instanceId");
          expect(located).not.toHaveProperty("instanceLabel");
        } else {
          expect(located.instanceId).toBe(route);
        }
        expect(located).toMatchObject({ backend: "codex", threadId: "target" });
      })), { numRuns: 25 });
  });

  // Rule: a card raised for a thread named by this instance is not
  // re-addressed to a peer that happens to report the same thread id.
  it("never re-addresses a card that names this instance to a peer", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const located = await fixture.registry.locateThreadTodoMessageTarget(
          { backend: "codex", threadId: "sender" }, { ...messageTarget(named), threadId: "elsewhere" },
        );
        const route = expectedRoute(localInstanceId, named);
        if (route === "local" && named) {
          expect(located).not.toHaveProperty("instanceId");
          expect(fixture.remoteReads).toEqual([]);
        } else if (route === "local") {
          expect(fixture.remoteReads).toEqual(["discover"]);
        } else {
          expect(located.instanceId).toBe(route);
        }
      })), { numRuns: 25 });
  });

  it("points a card naming its own thread by this owner's id at Do it here", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const sent = fixture.registry.sendThreadTodoMessage({
          sourceBackend: "codex", sourceThreadId: "sender",
          target: { ...messageTarget(named), threadId: "sender" },
          prompt: "Pick up the shutdown evidence", todo: { id: "todo", title: "Send evidence" },
        });
        if (expectedRoute(localInstanceId, named) === "local") {
          // Without an instance the card's own guard says Do it here first;
          // this layer keeps its own refusal for that case.
          await expect(sent).rejects.toThrow(named ? /Do it here/ : /another thread/);
          expect(fixture.remoteSends).toEqual([]);
        } else {
          await sent;
        }
        expect(fixture.submit).not.toHaveBeenCalled();
      })), { numRuns: 25 });
  });

  // Rule: naming this instance means this instance only. A thread it does
  // not own is missing here, not discovered on some peer instead.
  it("never widens a send that names this instance to a peer", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const route = expectedRoute(localInstanceId, named);
        const sent = fixture.registry.sendThreadTodoMessage({
          sourceBackend: "codex", sourceThreadId: "sender",
          target: { ...messageTarget(named), threadId: "elsewhere" },
          prompt: "Pick up the shutdown evidence", todo: { id: "todo", title: "Send evidence" },
        });
        if (route === "local" && named) {
          await expect(sent).rejects.toThrow(/not found/i);
          expect(fixture.remoteSends).toEqual([]);
        } else {
          await sent;
          expect(fixture.remoteSends).toEqual([route === "local" ? "discover" : route]);
        }
        expect(fixture.submit).not.toHaveBeenCalled();
      })), { numRuns: 25 });
  });

  it("steers this owner's own thread on the local route when the agent names this owner", async () => {
    const localInstanceId = "pwr_490f7727-674e-43d9-b9ee-be8387f39819";
    await withOwner({ localInstanceId, peers: ["pwr_peer"] }, async (fixture) => {
      await fixture.registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: {
        threadId: "sender", turnId: "sender-turn", turn: { id: "sender-turn" },
      } } });
      const response = await (fixture.registry as unknown as Internals).performThreadTurnControlWithFallback({
        operation: "steer_thread",
        context: { backend: "codex", threadId: "sender", turnId: "sender-turn" },
        args: {
          backend: "codex", threadId: "target", instanceId: localInstanceId, includeRemote: true,
          prompt: "New shutdown evidence", requestId: "steer-request",
        },
      });
      // The fixture's Codex client cannot steer, so the local route answers
      // for itself. What matters is that it was the local route.
      expect(fixture.remoteSends).toEqual([]);
      expect(response).not.toMatchObject({ error: { message: expect.stringMatching(/enrolled/) } });
      expect(response).toMatchObject({ ok: false, error: { data: { backend: "codex", threadId: "target" } } });
    });
  });
});

describe("owner-local thread inspection targets", () => {
  const inspect = (registry: DesktopBackendRegistry, request: Parameters<
    ReturnType<typeof registryModules>["threadInspectionTools"]["handleThreadInspectionRequest"]
  >[0]) => registryModules(registry).threadInspectionTools.handleThreadInspectionRequest(request);
  const context = { backend: "codex" as const, threadId: "sender" };

  // Rule: get_thread_status reads this owner's own thread locally when the
  // agent names this owner, and asks only the named peer otherwise.
  it("reads a thread's status from the instance the agent names", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const response = await inspect(fixture.registry, {
          operation: "get_thread_status", context,
          args: { backend: "codex", threadId: "target", ...(named ? { instanceId: named } : {}) },
        });
        const route = expectedRoute(localInstanceId, named);
        expect(response).toMatchObject({ ok: true, data: { thread: {
          title: route === "local" ? "M2 destination" : "Peer thread",
        } } });
        expect(fixture.remoteReads).toEqual(route === "local" ? [] : [route]);
      })), { numRuns: 25 });
  });

  it("reports a thread missing here when the agent names this instance", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const response = await inspect(fixture.registry, {
          operation: "get_thread_status", context,
          args: { backend: "codex", threadId: "elsewhere", ...(named ? { instanceId: named } : {}) },
        });
        const route = expectedRoute(localInstanceId, named);
        if (route === "local" && named) {
          expect(response.ok).toBe(false);
          expect(fixture.remoteReads).toEqual([]);
        } else {
          expect(response).toMatchObject({ ok: true, data: { thread: { title: "Peer thread" } } });
          expect(fixture.remoteReads).toEqual([route === "local" ? "discover" : route]);
        }
      })), { numRuns: 25 });
  });

  // Rule: mutate_thread changes this owner's own thread here. A dry run
  // never reaches federation for a thread this owner holds.
  it("mutates this owner's own thread locally when the agent names this owner", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        await inspect(fixture.registry, {
          operation: "mutate_thread", context,
          args: { backend: "codex", threadId: "target", title: "Renamed", dryRun: true,
            ...(named ? { instanceId: named } : {}) },
        });
        const route = expectedRoute(localInstanceId, named);
        expect(fixture.remoteReads).toEqual(route === "local" ? [] : [route]);
      })), { numRuns: 25 });
  });

  // Rule: a search scoped to this instance searches this instance only.
  it("scopes a search to the instance the agent names", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ localInstanceId, peers, named }) =>
      withOwner({ localInstanceId, peers }, async (fixture) => {
        const response = await inspect(fixture.registry, {
          operation: "search_threads", context,
          args: { query: "M2 destination", ...(named ? { instanceId: named } : {}) },
        });
        expect(response.ok).toBe(true);
        const route = expectedRoute(localInstanceId, named);
        expect(fixture.remoteReads).toEqual(!named ? ["discover"] : route === "local" ? [] : [route]);
      })), { numRuns: 25 });
  });
});
