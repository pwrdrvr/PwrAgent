import { describe, expect, it, vi } from "vitest";
import type {
  AppServerThreadSummary,
  BackendSummary,
  ThreadAgentMetadata,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingDefaultAgentAssignmentRecord,
  MessagingObservedSurfaceRecord,
} from "@pwragent/messaging-interface";
import {
  clearDesktopMessagingDefaultAgent,
  listDesktopMessagingRoutes,
  resetDesktopMessagingToolUpdateBindings,
  setDesktopMessagingDefaultAgent,
} from "../messaging/messaging-routes-service";

function buildThread(
  overrides: Partial<AppServerThreadSummary> = {},
): AppServerThreadSummary {
  return {
    id: "agent-1",
    title: "Search Signals Agent",
    titleSource: "explicit",
    linkedDirectories: [],
    source: "codex",
    updatedAt: 2000,
    ...overrides,
  };
}

function buildAgentMetadata(): ThreadAgentMetadata {
  return {
    name: "Search Signals Agent",
    instructionLineCount: 1,
    instructionsTooLong: false,
    updatedAt: 1000,
  };
}

function buildBackend(
  overrides: Partial<BackendSummary> = {},
): BackendSummary {
  return {
    kind: "codex",
    label: "Codex",
    available: true,
    methods: [],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: true,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: true,
      transcriptPagination: true,
      toolUse: true,
      approvalRequests: true,
      multiDirectoryThreads: true,
    },
    executionModes: [],
    ...overrides,
  };
}

function buildAssignment(
  overrides: Partial<MessagingDefaultAgentAssignmentRecord> = {},
): MessagingDefaultAgentAssignmentRecord {
  return {
    id: "assignment-1",
    scope: {
      kind: "conversation",
      channel: {
        channel: "slack",
        conversation: {
          id: "C13056",
          kind: "channel",
          title: "p-search-signals-project",
          workspaceId: "T1",
        },
      },
    },
    target: { kind: "agent", backend: "codex", threadId: "agent-1" },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function buildBinding(
  overrides: Partial<MessagingBindingRecord> = {},
): MessagingBindingRecord {
  return {
    id: "binding-1",
    channel: {
      channel: "slack",
      conversation: {
        id: "1700000000.000100",
        kind: "thread",
        title: "13056 investigation",
        parentTitle: "p-search-signals-project",
      },
    },
    backend: "codex",
    threadId: "work-1",
    targetKind: "thread",
    authorizedActorIds: ["U1"],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function buildDependencies(options: {
  assignments?: MessagingDefaultAgentAssignmentRecord[];
  backends?: BackendSummary[];
  bindings?: MessagingBindingRecord[];
  observedSurfaces?: MessagingObservedSurfaceRecord[];
  threads?: AppServerThreadSummary[];
} = {}) {
  const assignments = options.assignments ?? [buildAssignment()];
  const bindings = options.bindings ?? [buildBinding()];
  const threads = options.threads ?? [
    buildThread(),
    buildThread({ id: "work-1", title: "Issue 13056", updatedAt: 1500 }),
  ];
  const store = {
    findActiveDefaultAgentAssignments: vi.fn(async () => assignments),
    findActiveBindings: vi.fn(async () => bindings),
    findObservedSurfaces: vi.fn(async () => options.observedSurfaces ?? []),
    getDefaultAgentAssignment: vi.fn(async (id: string) =>
      assignments.find((assignment) => assignment.id === id)),
    upsertBinding: vi.fn(async (binding) => binding),
    upsertDefaultAgentAssignment: vi.fn(async (assignment) => assignment),
    revokeDefaultAgentAssignment: vi.fn(async ({ assignmentId, revokedAt }) => {
      const assignment = assignments.find((candidate) => candidate.id === assignmentId);
      return assignment ? { ...assignment, revokedAt, updatedAt: revokedAt } : undefined;
    }),
  };
  const registry = {
    listBackends: vi.fn(async () => ({
      backends: options.backends ?? [buildBackend()],
    })),
    listThreads: vi.fn(async () => threads),
    getThreadAgentMetadata: vi.fn(async ({ threadId }: { threadId: string }) =>
      threadId === "agent-1" ? buildAgentMetadata() : undefined),
  };
  return { store, registry };
}

describe("messaging routes service", () => {
  it("lists default Agents, active bindings, and eligible Agent choices", async () => {
    const dependencies = buildDependencies();

    const result = await listDesktopMessagingRoutes(dependencies);

    expect(result.eligibleAgents).toEqual([
      expect.objectContaining({
        backend: "codex",
        threadId: "agent-1",
        label: "Search Signals Agent",
        backendAvailable: true,
        available: true,
      }),
    ]);
    expect(result.defaultAgents).toEqual([
      expect.objectContaining({
        assignmentId: "assignment-1",
        scope: expect.objectContaining({
          kind: "conversation",
          platform: "slack",
        }),
        target: expect.objectContaining({ label: "Search Signals Agent" }),
      }),
    ]);
    expect(result.bindings).toEqual([
      expect.objectContaining({
        bindingId: "binding-1",
        platform: "slack",
        target: expect.objectContaining({
          backendAvailable: true,
          backendLabel: "Codex",
          label: "Issue 13056",
        }),
      }),
    ]);
    expect(result.observedSurfaces).toEqual([
      expect.objectContaining({
        platform: "slack",
        conversation: expect.objectContaining({
          id: "1700000000.000100",
          title: "13056 investigation",
        }),
        firstSeenAt: 1000,
        lastSeenAt: 2000,
      }),
    ]);
  });

  it("merges durable observations with active binding surfaces by recency", async () => {
    const dependencies = buildDependencies({
      observedSurfaces: [
        {
          channel: {
            channel: "slack",
            conversation: {
              id: "C13056",
              kind: "channel",
              title: "p-search-signals-project",
              workspaceId: "T1",
            },
          },
          firstSeenAt: 500,
          lastSeenAt: 3000,
        },
      ],
    });

    const result = await listDesktopMessagingRoutes(dependencies);

    expect(result.observedSurfaces.map((surface) => surface.conversation.id)).toEqual([
      "C13056",
      "1700000000.000100",
    ]);
  });

  it("excludes Agents on unavailable backends and marks routes unavailable", async () => {
    const dependencies = buildDependencies({
      backends: [buildBackend({ available: false })],
    });

    const result = await listDesktopMessagingRoutes(dependencies);

    expect(result.eligibleAgents).toEqual([]);
    expect(result.defaultAgents[0]?.target).toMatchObject({
      backend: "codex",
      backendAvailable: false,
      backendLabel: "Codex",
      available: false,
    });
    expect(result.bindings[0]?.target).toMatchObject({
      backend: "codex",
      backendAvailable: false,
      backendLabel: "Codex",
    });
    await expect(
      setDesktopMessagingDefaultAgent(
        {
          scope: { kind: "profile" },
          target: { backend: "codex", threadId: "agent-1" },
        },
        dependencies,
      ),
    ).rejects.toThrow("not an eligible default Agent");
  });

  it("keeps stale default targets visible for repair", async () => {
    const dependencies = buildDependencies({
      assignments: [
        buildAssignment({
          target: {
            kind: "agent",
            backend: "codex",
            threadId: "missing-agent",
          },
        }),
      ],
    });

    const result = await listDesktopMessagingRoutes(dependencies);

    expect(result.defaultAgents[0]?.target).toMatchObject({
      threadId: "missing-agent",
      label: "missing-agent",
      backendAvailable: true,
      available: false,
    });
  });

  it("resolves a legacy binding backend from its thread", async () => {
    const dependencies = buildDependencies({
      bindings: [buildBinding({ backend: undefined })],
    });

    const result = await listDesktopMessagingRoutes(dependencies);

    expect(result.bindings[0]?.target).toMatchObject({
      backend: "codex",
      threadId: "work-1",
    });
  });

  it("creates and retargets assignments only to eligible Agents", async () => {
    const dependencies = buildDependencies();

    await expect(
      setDesktopMessagingDefaultAgent(
        {
          scope: { kind: "provider", platform: "slack" },
          target: { backend: "codex", threadId: "agent-1" },
        },
        { ...dependencies, now: () => 3000, newId: () => "assignment-new" },
      ),
    ).resolves.toEqual({ assignmentId: "assignment-new" });
    expect(dependencies.store.upsertDefaultAgentAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "assignment-new",
        scope: { kind: "provider", channel: "slack" },
      }),
    );

    await expect(
      setDesktopMessagingDefaultAgent(
        {
          scope: { kind: "profile" },
          target: { backend: "codex", threadId: "work-1" },
        },
        dependencies,
      ),
    ).rejects.toThrow("not an eligible default Agent");
  });

  it("clears assignments by id", async () => {
    const dependencies = buildDependencies();

    await expect(
      clearDesktopMessagingDefaultAgent(
        { assignmentId: "assignment-1" },
        { ...dependencies, now: () => 4000 },
      ),
    ).resolves.toEqual({ assignmentId: "assignment-1", cleared: true });
    expect(dependencies.store.revokeDefaultAgentAssignment).toHaveBeenCalledWith({
      assignmentId: "assignment-1",
      revokedAt: 4000,
    });
  });

  it("resets only the selected binding kind to inherit its profile default", async () => {
    const developmentBinding = buildBinding({
      preferences: {
        model: "gpt-5.6",
        toolUpdateMode: "show_all",
        updatedAt: 1200,
      },
    });
    const managerBinding = buildBinding({
      id: "binding-manager",
      targetKind: "agent_thread",
      preferences: {
        toolUpdateMode: "show_more",
        updatedAt: 1300,
      },
    });
    const dependencies = buildDependencies({
      bindings: [developmentBinding, managerBinding],
    });

    await expect(
      resetDesktopMessagingToolUpdateBindings(
        { targetKind: "thread" },
        { ...dependencies, now: () => 4000 },
      ),
    ).resolves.toEqual({ bindingCount: 1 });
    expect(dependencies.store.upsertBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "binding-1",
        preferences: { model: "gpt-5.6", updatedAt: 4000 },
        updatedAt: 4000,
      }),
    );
    expect(dependencies.store.upsertBinding).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "binding-manager" }),
    );

    await expect(
      resetDesktopMessagingToolUpdateBindings(
        { targetKind: "agent_thread" },
        { ...dependencies, now: () => 5000 },
      ),
    ).resolves.toEqual({ bindingCount: 1 });
    expect(dependencies.store.upsertBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "binding-manager",
        preferences: undefined,
        updatedAt: 5000,
      }),
    );
  });
});
