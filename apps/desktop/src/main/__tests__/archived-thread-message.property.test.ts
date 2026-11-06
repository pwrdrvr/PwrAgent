import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
  AppServerThreadSummary,
  MutateThreadToolArgs,
  PwrAgentThreadInspectionResponse,
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import * as appState from "../state/app-state";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import { getThreadTodoService, installThreadTodoRuntime, resetThreadTodoServiceForTests } from "../thread-todos/thread-todo-runtime";
import { openInMemoryStateDb } from "./sqlite-test-utils";

type Internals = {
  threadTodoHandler: PwrAgentThreadTodoHandler;
  deliverMessageToThread(request: PwrAgentThreadOrchestrationRequest<"send_message_to_thread">): Promise<PwrAgentThreadOrchestrationResponse>;
  handleGetThreadStatusInspectionRequest(args: { backend: "codex"; threadId: string; includeRemote: false }, context: { backend: "codex"; threadId: string }): Promise<PwrAgentThreadInspectionResponse>;
  handleMutateThreadInspectionRequest(args: MutateThreadToolArgs): Promise<PwrAgentThreadInspectionResponse>;
  performThreadTurnControl(request: PwrAgentThreadOrchestrationRequest<"steer_thread">): Promise<PwrAgentThreadOrchestrationResponse>;
};

async function fixture(archived: boolean, run: (
  registry: DesktopBackendRegistry,
  archive: () => Promise<void>,
  db: ReturnType<typeof openInMemoryStateDb>,
) => Promise<void>) {
  const db = openInMemoryStateDb();
  let providerArchived = archived;
  // The provider's archive partition is the oracle. Codex can omit archivedAt
  // from its rows, and notLoaded is a runtime state in either partition.
  const target: AppServerThreadSummary = {
    id: "target", source: "codex", title: "Launcher shutdown", titleSource: "explicit",
    linkedDirectories: [], threadStatus: "notLoaded",
  };
  const registry = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      onNotification: () => () => {}, onPendingRequest: () => () => {},
      listThreads: async (params: { archived?: boolean }) => (params.archived === true) === providerArchived ? [target] : [],
      readConfiguredMcpServerNames: async () => [],
    } as never,
    overlayStore: new SqliteOverlayStore(db), threadTitleGenerationService: null,
  });
  try {
    await run(registry, async () => {
      providerArchived = true;
      await registry.publishLocalEvent({ backend: "codex", notification: { method: "thread/archived", params: { threadId: "target" } } });
    }, db);
  } finally {
    resetThreadTodoServiceForTests();
    await registry.close();
    vi.restoreAllMocks();
    db.close();
  }
}

const request: PwrAgentThreadOrchestrationRequest<"send_message_to_thread"> = {
  operation: "send_message_to_thread",
  context: { backend: "codex", threadId: "sender", turnId: "sender-turn" },
  args: { backend: "codex", threadId: "target", prompt: "New shutdown evidence", includeRemote: false },
};

function captureSubmissions(registry: DesktopBackendRegistry) {
  return vi.spyOn(registry, "submitTurn").mockImplementation(async (turn) => ({
    status: "queued", entry: { ...turn, id: "queued", createdAt: 1 }, position: 1,
  }) as Awaited<ReturnType<DesktopBackendRegistry["submitTurn"]>>);
}

function installTodos(registry: DesktopBackendRegistry, db: ReturnType<typeof openInMemoryStateDb>) {
  vi.spyOn(appState, "getAppStateDb").mockReturnValue(db);
  installThreadTodoRuntime({
    registry, broadcast: () => {}, listProjects: async () => [], readDefaultMergeMethod: () => "squash",
    feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} },
  });
  return (registry as unknown as Internals).threadTodoHandler;
}

const cardInput = {
  title: "Send shutdown evidence",
  action: { type: "send_message" as const, target: { backend: "codex" as const, threadId: "target" }, prompt: request.args.prompt },
};

describe("archived thread message admission", () => {
  it("refuses an archived thread through the preferred steering route", async () => {
    await fixture(true, async (registry) => {
      await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: {
        threadId: "sender", turnId: "sender-turn", turn: { id: "sender-turn" },
      } } });
      const response = await (registry as unknown as Internals).performThreadTurnControl({
        operation: "steer_thread", context: request.context,
        args: { ...request.args, requestId: "steer-request" },
      });
      expect(response).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringMatching(/archived.*cannot send/i) } });
    });
  });

  it("refuses a new card when the explicitly selected peer reports its target archived", async () => {
    await fixture(false, async (registry, _archive, db) => {
      const handler = installTodos(registry, db);
      registry.setFederatedThreadInspectionHandler(async () => ({
        instanceId: "peer", instanceLabel: "Peer", archived: true,
        thread: { id: "target", title: "Peer target", titleSource: "explicit", source: "codex", linkedDirectories: [] },
        read: { backend: "codex", fetchedAt: 1, threadId: "target", replay: {
          entries: [], messages: [], threadStatus: "notLoaded",
          pagination: { supportsPagination: false, hasPreviousPage: false },
        } },
      }));
      await expect(handler.add({ backend: "codex", threadId: "sender" }, {
        ...cardInput, action: { ...cardInput.action, target: {
          ...cardInput.action.target, instanceId: "peer", instanceLabel: "Peer", title: "Peer target",
        } },
      })).rejects.toThrow(/archived.*cannot send/i);
      expect(getThreadTodoService().list({ status: "all" })).toEqual([]);
    });
  });

  it("refuses to create a message card addressed to an already archived thread", async () => {
    await fixture(true, async (registry, _archive, db) => {
      const handler = installTodos(registry, db);
      await expect(handler.add({ backend: "codex", threadId: "sender" }, cardInput))
        .rejects.toThrow(/archived.*cannot send/i);
      expect(getThreadTodoService().list({ status: "all" })).toEqual([]);
    });
  });

  it("keeps a card open with an archived-thread error when its target is archived after creation", async () => {
    await fixture(false, async (registry, archive, db) => {
      const handler = installTodos(registry, db);
      const { todo } = await handler.add({ backend: "codex", threadId: "sender" }, cardInput);
      const submit = captureSubmissions(registry);
      await archive();
      expect(await getThreadTodoService().runAction(todo.id)).toMatchObject({
        id: todo.id, status: "open", error: expect.stringMatching(/archived.*cannot send/i),
      });
      expect(getThreadTodoService().list({ status: "open" })).toMatchObject([
        { id: todo.id, status: "open", error: expect.stringMatching(/archived.*cannot send/i) },
      ]);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("reports an archived destination and asks for restoration instead of saying it is missing", async () => {
    await fixture(true, async (registry) => {
      const submit = captureSubmissions(registry);
      const response = await (registry as unknown as Internals).deliverMessageToThread(request);
      expect(response).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringMatching(/archived.*restore/i) } });
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("reports archive membership even when the provider has no archive timestamp", async () => {
    await fixture(true, async (registry) => {
      const response = await (registry as unknown as Internals).handleGetThreadStatusInspectionRequest(
        { backend: "codex", threadId: "target", includeRemote: false },
        { backend: "codex", threadId: "sender" },
      );
      expect(response).toMatchObject({ ok: true, data: { thread: { archived: true } } });
    });
  });

  it("lets the operator restore an archived thread with no archive timestamp", async () => {
    await fixture(true, async (registry) => {
      const response = await (registry as unknown as Internals).handleMutateThreadInspectionRequest({
        backend: "codex", threadId: "target", archive: false, includeRemote: false, dryRun: true,
      });
      expect(response).toMatchObject({ ok: true });
    });
  });

  it("shows the restoration instruction when the operator sends the to-do card", async () => {
    await fixture(true, async (registry) => {
      const submit = captureSubmissions(registry);
      await expect(registry.sendThreadTodoMessage({
        sourceBackend: "codex", sourceThreadId: "sender",
        target: { backend: "codex", threadId: "target" }, prompt: request.args.prompt,
        todo: { id: "todo", title: "Send shutdown evidence" },
      })).rejects.toThrow(/archived.*restore/i);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("leaves an explicitly selected peer in charge of its thread", async () => {
    await fixture(true, async (registry) => {
      const submit = captureSubmissions(registry);
      const remote = vi.fn(async () => ({
        backend: "codex" as const, threadId: "target", turnId: "remote-turn",
        instanceId: "peer", instanceLabel: "Peer", title: "Peer target",
      }));
      registry.setFederatedThreadMessageHandler(remote);
      const response = await (registry as unknown as Internals).deliverMessageToThread({
        ...request, args: { ...request.args, instanceId: "peer", includeRemote: true },
      });
      expect(response).toMatchObject({ ok: true, data: { instanceId: "peer" } });
      expect(remote).toHaveBeenCalledOnce();
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("still discovers a peer when the local archive lookup fails", async () => {
    await fixture(true, async (registry) => {
      const list = registry.listThreads.bind(registry);
      vi.spyOn(registry, "listThreads").mockImplementation(async (params) => {
        if (params?.archived) throw new Error("Local archive listing unavailable");
        return await list(params);
      });
      registry.setFederatedThreadMessageHandler(async () => ({
        backend: "codex", threadId: "target", turnId: "remote-turn",
        instanceId: "peer", instanceLabel: "Peer", title: "Peer target",
      }));
      const response = await (registry as unknown as Internals).deliverMessageToThread({
        ...request, args: { ...request.args, includeRemote: true },
      });
      expect(response).toMatchObject({ ok: true, data: { instanceId: "peer" } });
    });
  });

  it("keeps a genuinely missing destination classified as not found", async () => {
    await fixture(false, async (registry) => {
      const submit = captureSubmissions(registry);
      const response = await (registry as unknown as Internals).deliverMessageToThread({
        ...request, args: { ...request.args, threadId: "missing" },
      });
      expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(submit).not.toHaveBeenCalled();
    });
  });

  // Rule: reading active or archived metadata cannot change whether a message
  // is admitted. Only the provider's current archive partition decides that.
  it("keeps message admission independent of metadata lookup order", async () => {
    await fc.assert(fc.asyncProperty(
      fc.boolean(), fc.array(fc.boolean(), { maxLength: 5 }),
      async (archived, reads) => fixture(archived, async (registry) => {
        const submit = captureSubmissions(registry);
        for (const archivedRead of reads) {
          await registry.listThreads({ backend: "codex", archived: archivedRead, enrichDirectories: false });
        }
        const status = await (registry as unknown as Internals).handleGetThreadStatusInspectionRequest(
          { backend: "codex", threadId: "target", includeRemote: false },
          { backend: "codex", threadId: "sender" },
        );
        expect(status).toMatchObject({ ok: true, data: { thread: { archived } } });
        const destination = registry.locateThreadTodoMessageTarget(
          { backend: "codex", threadId: "sender" }, { backend: "codex", threadId: "target" },
        );
        if (archived) await expect(destination).rejects.toThrow(/archived.*cannot send/i);
        else await expect(destination).resolves.toMatchObject({ threadId: "target" });
        const response = await (registry as unknown as Internals).deliverMessageToThread(request);
        expect(response.ok).toBe(!archived);
        expect(submit).toHaveBeenCalledTimes(archived ? 0 : 1);
        if (!response.ok) {
          expect(response.error.code).toBe("forbidden");
          expect(response.error.message).toMatch(/archived.*restore/i);
        }
      }),
    ), { numRuns: 25 });
  });

  it("does not let an archived-list cache entry satisfy active thread resolution", async () => {
    await fixture(true, async (registry) => {
      await registry.listThreads({ backend: "codex", archived: true, enrichDirectories: false });
      expect(await registry.resolveThread({ backend: "codex", threadId: "target" })).toBeUndefined();
    });
  });
});
