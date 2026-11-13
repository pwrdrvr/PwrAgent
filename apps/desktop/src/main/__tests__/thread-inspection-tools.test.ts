import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, PwrAgentThreadInspectionRequest } from "@pwragent/shared";
import {
  THREAD_MAINTENANCE_CONFIRM_APPROVE_LABEL,
  THREAD_MAINTENANCE_CONFIRM_QUESTION_ID,
} from "../app-server/backend-registry-runtime-helpers";
import type { PendingServerRequest, ThreadMaintenanceToolHandler } from "../app-server/backend-registry-types";
import type { ForgeToolBridge } from "../app-server/forge-tool-bridge";
import type { RegistryContext } from "../app-server/registry-context";
import {
  ThreadInspectionTools,
  type ThreadInspectionToolsHandlers,
  type ThreadInspectionToolsHost,
} from "../app-server/thread-inspection-tools";
import { buildPendingRequestKey } from "../app-server/thread-turn-keys";

const callContext = { backend: "codex", threadId: "caller", turnId: "turn-1", callId: "call-1" } as const;

function createTools(options: {
  handlers?: ThreadInspectionToolsHandlers;
  host?: Partial<ThreadInspectionToolsHost>;
} = {}) {
  const events: AgentEvent[] = [];
  const pendingServerRequests = new Map<string, PendingServerRequest>();
  // Every host member the tools touch is recorded, so a refused call can be
  // shown to have reached nothing.
  const reads: string[] = [];
  const base = { pendingServerRequests, messagingStore: null, ...options.host };
  const host = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === "string") reads.push(property);
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as ThreadInspectionToolsHost;
  const context = {
    stores: { threads: { getThreadOverlayState: async () => undefined } },
    lifecycle: { closed: false },
    emit: async (event: AgentEvent) => { events.push(event); },
  } as unknown as RegistryContext;
  const tools = new ThreadInspectionTools(context, options.handlers ?? {}, {
    forgeToolBridge: {} as ForgeToolBridge,
    threadInspectionSearchService: null,
  }, () => host);
  return { tools, events, pendingServerRequests, reads };
}

function inspect(tools: ThreadInspectionTools, request: Omit<PwrAgentThreadInspectionRequest, "context">) {
  return tools.handleThreadInspectionRequest({ ...request, context: callContext } as PwrAgentThreadInspectionRequest);
}

function binding(id: string, createdAt: number) {
  return {
    id, createdAt, updatedAt: createdAt + 1,
    channel: { channel: "telegram", conversation: { kind: "topic", title: `Topic ${id}` } },
  };
}

describe("ThreadInspectionTools", () => {
  it("reads neither its host nor its stores until a tool runs", async () => {
    let bound = false;
    const stores = {
      get threads() {
        if (!bound) throw new Error("store read while constructing");
        return { getThreadOverlayState: async () => undefined };
      },
    };
    const context = { stores, emit: async () => {} } as unknown as RegistryContext;
    const tools = new ThreadInspectionTools(context, {}, {
      forgeToolBridge: {} as ForgeToolBridge,
      threadInspectionSearchService: null,
    }, () => {
      if (!bound) throw new Error("host read while constructing");
      return { messagingStore: null } as unknown as ThreadInspectionToolsHost;
    });
    bound = true;
    await expect(tools.getThreadInspectionMessagingBindings({ backend: "codex", threadId: "thread-1" })).resolves.toBeUndefined();
  });

  it("refuses an operation it does not know", async () => {
    const { tools } = createTools();
    await expect(inspect(tools, { operation: "not_a_tool", args: {} } as never)).resolves.toEqual({
      ok: false,
      error: { code: "unsupported_operation", message: "Unsupported PwrAgent thread inspection operation." },
    });
  });

  it("offers thread maintenance only once the app-server service supplies its handler", async () => {
    const { tools } = createTools();
    await expect(inspect(tools, { operation: "open_thread_maintenance", args: {} })).resolves.toMatchObject({
      ok: false, error: { code: "unsupported_operation" },
    });
    const open = vi.fn(() => true);
    tools.setThreadMaintenanceToolHandler({ open, scan: vi.fn(), getScan: vi.fn(), getRun: vi.fn(), start: vi.fn() } as unknown as ThreadMaintenanceToolHandler);
    await expect(inspect(tools, { operation: "open_thread_maintenance", args: { projectKey: "  /repo  " } })).resolves.toEqual({
      ok: true, data: { maintenanceDialog: { opened: true } },
    });
    expect(open).toHaveBeenCalledWith({ projectKey: "/repo" });
    await expect(inspect(tools, { operation: "open_thread_maintenance", args: { rules: {} } as never })).resolves.toMatchObject({
      ok: false, error: { code: "invalid_arguments" },
    });
    tools.setThreadMaintenanceToolHandler(undefined);
    await expect(inspect(tools, { operation: "open_thread_maintenance", args: {} })).resolves.toMatchObject({
      ok: false, error: { code: "unsupported_operation" },
    });
  });

  it("approves a maintenance card only on the exact approve label", async () => {
    const label = fc.oneof(
      fc.constantFrom(THREAD_MAINTENANCE_CONFIRM_APPROVE_LABEL, "Cancel", "Register worktree", ""),
      fc.string(),
    );
    await fc.assert(fc.asyncProperty(
      fc.option(fc.array(label, { maxLength: 3 }), { nil: undefined }),
      fc.option(fc.constantFrom("Register worktree", "Unregister worktree"), { nil: undefined }),
      async (answers, approveLabel) => {
        const { tools, events, pendingServerRequests } = createTools();
        const approved = tools.requestThreadMaintenanceConfirmation({
          backend: "codex", threadId: "caller", requestId: "request-1", question: "Archive 2 threads?",
          ...(approveLabel ? { approveLabel } : {}),
        });
        const key = buildPendingRequestKey({ backend: "codex", threadId: "caller", requestId: "request-1" });
        // The card is registered and published before the first await.
        expect(pendingServerRequests.has(key)).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ backend: "codex", notification: { method: "item/tool/requestUserInput" } });
        pendingServerRequests.get(key)!.resolve({
          answers: answers === undefined ? {} : { [THREAD_MAINTENANCE_CONFIRM_QUESTION_ID]: { answers } },
        } as never);
        const expected = answers?.length === 1 && answers[0] === (approveLabel ?? THREAD_MAINTENANCE_CONFIRM_APPROVE_LABEL);
        expect(await approved).toBe(expected);
      },
    ), { numRuns: 60 });
  });

  it("lists a thread's messaging bindings by creation, then id, whatever order the store returns", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.record({ id: fc.stringMatching(/^[a-z]{1,4}$/), createdAt: fc.integer({ min: 0, max: 3 }) }), {
        selector: (entry) => entry.id, maxLength: 6,
      }),
      async (entries) => {
        const records = entries.map((entry) => binding(entry.id, entry.createdAt));
        const findActiveBindingsForThread = vi.fn(async () => records);
        const { tools } = createTools({ host: { messagingStore: { findActiveBindingsForThread } as never } });
        const summaries = await tools.getThreadInspectionMessagingBindings({ backend: "codex", threadId: "thread-1" });
        const oracle = [...entries]
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
          .map((entry) => entry.id);
        expect(summaries?.map((summary) => summary.bindingId)).toEqual(oracle.length ? oracle : undefined);
        expect(findActiveBindingsForThread).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1" });
      },
    ));
  });

  it("reports no messaging bindings when the store is off or fails", async () => {
    const off = createTools({ host: { messagingStore: null } });
    await expect(off.tools.getThreadInspectionMessagingBindings({ backend: "codex", threadId: "thread-1" })).resolves.toBeUndefined();
    const failing = createTools({ host: { messagingStore: {
      findActiveBindingsForThread: async () => { throw new Error("database is locked"); },
    } as never } });
    await expect(failing.tools.getThreadInspectionMessagingBindings({ backend: "codex", threadId: "thread-1" })).resolves.toBeUndefined();
  });

  it("requires a written continuation before a dependency is created", async () => {
    const unavailable = createTools();
    await expect(inspect(unavailable.tools, {
      operation: "manage_thread_dependencies", args: { action: "list" },
    } as never)).resolves.toMatchObject({ ok: false, error: { code: "unsupported_operation" } });

    const threadDependencyToolHandler = vi.fn();
    const { tools } = createTools({ host: { threadDependencyToolHandler } });
    for (const continuation of [undefined, "", "   "]) {
      await expect(inspect(tools, {
        operation: "manage_thread_dependencies",
        args: { action: "create", conditions: [], ...(continuation === undefined ? {} : { continuation }) },
      } as never)).resolves.toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    }
    expect(threadDependencyToolHandler).not.toHaveBeenCalled();
  });

  it("marks a project read only with an exact projectKey, through the owner's thread actions", async () => {
    const markProjectRead = vi.fn(async () => ({ projectKey: "/repo", markedThreadCount: 2 }));
    const { tools } = createTools({ host: { agentThreadActions: { markProjectRead } as never } });
    for (const args of [{}, { projectKey: " " }, { projectKey: "/repo", instanceId: " " }, { projectKey: "/repo", extra: true }]) {
      await expect(inspect(tools, { operation: "mark_project_read", args } as never)).resolves.toMatchObject({
        ok: false, error: { code: "invalid_arguments" },
      });
    }
    expect(markProjectRead).not.toHaveBeenCalled();
    await expect(inspect(tools, { operation: "mark_project_read", args: { projectKey: "/repo", instanceId: " peer " } }))
      .resolves.toEqual({ ok: true, data: { projectRead: { projectKey: "/repo", markedThreadCount: 2 } } });
    expect(markProjectRead).toHaveBeenCalledWith({ projectKey: "/repo", instanceId: "peer" });

    const unavailable = createTools({ host: { agentThreadActions: undefined } });
    await expect(inspect(unavailable.tools, { operation: "mark_project_read", args: { projectKey: "/repo" } }))
      .resolves.toMatchObject({ ok: false, error: { code: "unsupported_operation" } });
  });

  it("refuses a bad current-thread title before it reaches any thread state", async () => {
    const badTitle = fc.oneof(
      fc.constantFrom("", " ", "\n\t"),
      fc.string({ minLength: 201, maxLength: 260 }),
      fc.anything().filter((value) => typeof value !== "string"),
    );
    await fc.assert(fc.asyncProperty(badTitle, fc.boolean(), async (title, extraKey) => {
      const { tools, reads } = createTools();
      const args = { title, ...(extraKey ? { threadId: "other" } : {}) };
      await expect(inspect(tools, { operation: "rename_current_thread", args } as never)).resolves.toMatchObject({
        ok: false, error: { code: "invalid_arguments" },
      });
      expect(reads).toEqual([]);
    }));
  });

  it("refuses a versioned parent change that does not say whether it is a dry run", async () => {
    const { tools, reads } = createTools();
    await expect(tools.mutateThreadParentV1({ backend: "codex", threadId: "child", parentThreadId: "parent" } as never))
      .resolves.toEqual({ ok: false, error: { code: "invalid_arguments", message: "dryRun must be a boolean." } });
    expect(reads).toEqual([]);
  });

  it("refuses a peer search that excludes peers", async () => {
    const { tools, reads } = createTools();
    await expect(inspect(tools, { operation: "search_threads", args: { instanceId: "peer", includeRemote: false } }))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    await expect(inspect(tools, { operation: "search_threads", args: { instanceId: " " } }))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(reads).toEqual([]);
  });
});
