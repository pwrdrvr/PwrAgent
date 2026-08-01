import { describe, expect, it, vi } from "vitest";
import type {
  AppServerThreadSummary,
  BackendSummary,
  ThreadAgentMetadata,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingDefaultAgentAssignmentRecord,
} from "@pwragent/messaging-interface";
import {
  clearDesktopMessagingDefaultAgent,
  listDesktopMessagingRoutes,
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
  bindings?: MessagingBindingRecord[];
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
    getDefaultAgentAssignment: vi.fn(async (id: string) =>
      assignments.find((assignment) => assignment.id === id)),
    upsertDefaultAgentAssignment: vi.fn(async (assignment) => assignment),
    revokeDefaultAgentAssignment: vi.fn(async ({ assignmentId, revokedAt }) => {
      const assignment = assignments.find((candidate) => candidate.id === assignmentId);
      return assignment ? { ...assignment, revokedAt, updatedAt: revokedAt } : undefined;
    }),
  };
  const registry = {
    listBackends: vi.fn(async () => ({
      backends: [
        {
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
        } satisfies BackendSummary,
      ],
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
        target: expect.objectContaining({ label: "Issue 13056" }),
      }),
    ]);
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
});
