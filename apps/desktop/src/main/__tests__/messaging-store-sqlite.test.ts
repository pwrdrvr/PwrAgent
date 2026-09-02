import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingCallbackHandleRecord,
  MessagingDefaultAgentAssignmentRecord,
  MessagingManagedTopicRecord,
  MessagingMonitorSubscriptionRecord,
  MessagingPendingIntentRecord,
  MessagingThreadTopicLinkRecord,
  MessagingTopicCleanupProposalRecord,
} from "@pwragent/messaging-interface";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { StateDb } from "../state/state-db";

const tempDirs: string[] = [];
const stateDbs: StateDb[] = [];

async function createStore(): Promise<SqliteMessagingStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-sqlite-msg-"));
  tempDirs.push(tempDir);
  const stateDb = StateDb.open(path.join(tempDir, "state.db"));
  stateDbs.push(stateDb);
  return new SqliteMessagingStore(stateDb);
}

function buildBinding(
  overrides: Partial<MessagingBindingRecord> = {},
): MessagingBindingRecord {
  return {
    id: "binding-1",
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    backend: "codex",
    threadId: "thread-1",
    authorizedActorIds: ["user-1"],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function buildDefaultAgentAssignment(
  overrides: Partial<MessagingDefaultAgentAssignmentRecord> = {},
): MessagingDefaultAgentAssignmentRecord {
  return {
    id: "default-agent-1",
    scope: {
      kind: "conversation",
      channel: buildBinding().channel,
    },
    target: {
      kind: "agent",
      backend: "codex",
      threadId: "agent-thread-1",
    },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function buildMonitorSubscription(
  overrides: Partial<MessagingMonitorSubscriptionRecord> = {},
): MessagingMonitorSubscriptionRecord {
  return {
    id: "monitor:telegram:dm::chat-1",
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    authorizedActorIds: ["user-1"],
    createdAt: 1000,
    updatedAt: 1000,
    monitor: {
      enabled: true,
      intervalMs: 60_000,
      updatedAt: 1000,
    },
    ...overrides,
  };
}

function buildManagedTopic(
  overrides: Partial<MessagingManagedTopicRecord> = {},
): MessagingManagedTopicRecord {
  return {
    id: "topic:telegram:-1001:100",
    authorizedActorIds: ["user-1"],
    channel: "telegram",
    conversation: {
      id: "100",
      kind: "topic",
      parentId: "-1001",
      title: "PwrAgent",
    },
    createdAt: 1000,
    lifecycle: "open",
    source: "owned",
    supergroupId: "-1001",
    title: "PwrAgent",
    topicId: "100",
    updatedAt: 1000,
    ...overrides,
  };
}

function buildTopicLink(
  overrides: Partial<MessagingThreadTopicLinkRecord> = {},
): MessagingThreadTopicLinkRecord {
  return {
    id: "topic-link:telegram:-1001:codex:thread-1",
    backend: "codex",
    channel: "telegram",
    createdAt: 1000,
    supergroupId: "-1001",
    threadId: "thread-1",
    topicRecordId: "topic:telegram:-1001:100",
    updatedAt: 1000,
    ...overrides,
  };
}

function buildCleanupProposal(
  overrides: Partial<MessagingTopicCleanupProposalRecord> = {},
): MessagingTopicCleanupProposalRecord {
  return {
    id: "proposal-1",
    authorizedActorIds: ["user-1"],
    channel: "telegram",
    createdAt: 1000,
    items: [
      {
        id: "100",
        action: "close",
        reason: "inactive",
        topicRecordId: "topic:telegram:-1001:100",
      },
    ],
    status: "pending",
    supergroupId: "-1001",
    updatedAt: 1000,
    ...overrides,
  };
}

function buildPendingIntent(
  overrides: Partial<MessagingPendingIntentRecord> = {},
): MessagingPendingIntentRecord {
  return {
    id: "intent-1",
    bindingId: "binding-1",
    allowedActorIds: ["user-1"],
    createdAt: 1000,
    expiresAt: 2000,
    intent: {
      id: "surface-1",
      kind: "single_select",
      createdAt: 1000,
      prompt: "Choose",
      choices: [{ id: "choice-a", label: "Choice A" }],
    },
    ...overrides,
  };
}

function buildCallbackHandle(
  overrides: Partial<MessagingCallbackHandleRecord> = {},
): MessagingCallbackHandleRecord {
  return {
    id: "callback-1",
    actionId: "status:refresh",
    allowedActorIds: ["user-1"],
    bindingId: "binding-1",
    channel: buildBinding().channel,
    createdAt: 1000,
    updatedAt: 1000,
    expiresAt: 2000,
    handle: "tg:short",
    ...overrides,
  };
}

afterEach(async () => {
  for (const stateDb of stateDbs.splice(0)) {
    stateDb.close();
  }
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      rm(tempDir, { recursive: true, force: true }),
    ),
  );
});

describe("SqliteMessagingStore", () => {
  it("keeps observed surfaces enriched and ordered by recent activity", async () => {
    const store = await createStore();
    await store.upsertObservedSurface({
      channel: "slack",
      conversation: {
        id: "C1",
        kind: "channel",
        workspaceId: "T1",
      },
    }, 2000);
    await store.upsertObservedSurface({
      channel: "slack",
      conversation: {
        id: "C1",
        kind: "channel",
        title: "p-search-signals-project",
        workspaceId: "T1",
      },
    }, 1000);
    await store.upsertObservedSurface({
      channel: "telegram",
      conversation: {
        id: "42",
        kind: "topic",
        parentConversationId: "-1001",
        parentId: "-1001",
        parentTitle: "PwrAgent Dev",
        title: "Releases",
      },
    }, 3000);

    await expect(store.findObservedSurfaces()).resolves.toEqual([
      expect.objectContaining({
        channel: expect.objectContaining({
          channel: "telegram",
          conversation: expect.objectContaining({ id: "42" }),
        }),
        firstSeenAt: 3000,
        lastSeenAt: 3000,
      }),
      expect.objectContaining({
        channel: expect.objectContaining({
          channel: "slack",
          conversation: expect.objectContaining({
            id: "C1",
            title: "p-search-signals-project",
            workspaceId: "T1",
          }),
        }),
        firstSeenAt: 1000,
        lastSeenAt: 2000,
      }),
    ]);
  });

  it("preserves normalized parent identity on observed Discord threads", async () => {
    const store = await createStore();
    await store.upsertObservedSurface({
      channel: "discord",
      conversation: {
        id: "thread-channel-1",
        kind: "thread",
        parentConversationId: "parent-channel-1",
        parentConversationParentId: "guild-1",
        parentId: "guild-1",
        workspaceId: "guild-1",
      },
    }, 1000);

    await expect(store.findObservedSurfaces()).resolves.toEqual([
      expect.objectContaining({
        channel: {
          channel: "discord",
          conversation: expect.objectContaining({
            id: "thread-channel-1",
            parentConversationId: "parent-channel-1",
            parentConversationParentId: "guild-1",
          }),
        },
      }),
    ]);
  });

  it("remembers bound conversations as observed surfaces", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding({
      channel: {
        channel: "slack",
        conversation: {
          id: "C13056",
          kind: "channel",
          title: "p-search-signals-project",
          workspaceId: "T1",
        },
      },
      createdAt: 1000,
      updatedAt: 2000,
    }));

    await expect(store.findObservedSurfaces()).resolves.toEqual([
      expect.objectContaining({
        channel: expect.objectContaining({
          conversation: expect.objectContaining({ id: "C13056" }),
        }),
        firstSeenAt: 2000,
        lastSeenAt: 2000,
      }),
    ]);
  });

  it("persists Agent-thread binding targets", async () => {
    const store = await createStore();
    await store.upsertBinding(
      buildBinding({
        targetKind: "agent_thread",
      }),
    );

    await expect(store.getBinding("binding-1")).resolves.toMatchObject({
      id: "binding-1",
      targetKind: "agent_thread",
    });
  });

  it("atomically rejects stale binding metadata after revocation", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding());
    await store.revokeBinding({
      bindingId: "binding-1",
      revokedAt: 1_001,
    });

    await expect(store.mergeBindingChannelMetadata({
      bindingId: "binding-1",
      channel: buildBinding().channel,
      observedAt: 1_000,
      title: "Stale title",
    })).resolves.toBeUndefined();
    await expect(store.getBinding("binding-1")).resolves.toMatchObject({
      revokedAt: 1_001,
      updatedAt: 1_001,
    });
  });

  it("finds a legacy channel-shaped binding from its normalized thread surface", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding({
      channel: {
        channel: "discord",
        conversation: {
          id: "thread-channel-1",
          kind: "channel",
          parentId: "guild-1",
        },
      },
    }));

    await expect(
      store.findActiveBindingForChannel({
        channel: "discord",
        conversation: {
          id: "thread-channel-1",
          kind: "thread",
          parentConversationId: "parent-channel-1",
          parentId: "guild-1",
          workspaceId: "guild-1",
        },
      }),
    ).resolves.toMatchObject({
      id: "binding-1",
      threadId: "thread-1",
    });
  });

  it("finds a root DM binding from an Agent Session thread surface", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding({
      channel: {
        channel: "slack",
        conversation: {
          id: "D012ABCDEF0",
          isDirectMessage: true,
          kind: "dm",
        },
      },
    }));

    await expect(
      store.findActiveBindingForChannel({
        channel: "slack",
        conversation: {
          id: "D012ABCDEF0",
          isDirectMessage: true,
          kind: "thread",
          parentConversationId: "D012ABCDEF0",
          parentId: "1782234671.392669",
        },
      }),
    ).resolves.toMatchObject({
      id: "binding-1",
      threadId: "thread-1",
    });
  });

  it("keeps default Agent assignments separate from active bindings", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding({ threadId: "work-thread-1" }));
    await store.upsertDefaultAgentAssignment(buildDefaultAgentAssignment());

    await expect(store.findActiveBindingForChannel(buildBinding().channel)).resolves
      .toMatchObject({
        id: "binding-1",
        threadId: "work-thread-1",
      });
    await expect(
      store.findActiveDefaultAgentAssignmentForChannel(buildBinding().channel),
    ).resolves.toMatchObject({
      id: "default-agent-1",
      target: { threadId: "agent-thread-1" },
    });
  });

  it("lists only active default Agent assignments and bindings", async () => {
    const store = await createStore();
    await store.upsertDefaultAgentAssignment(buildDefaultAgentAssignment());
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "profile-default",
        scope: { kind: "profile" },
        createdAt: 2000,
        updatedAt: 2000,
      }),
    );
    await store.revokeDefaultAgentAssignment({
      assignmentId: "default-agent-1",
      revokedAt: 3000,
    });
    await store.upsertBinding(buildBinding());
    await store.upsertBinding(
      buildBinding({
        id: "binding-2",
        channel: {
          channel: "slack",
          conversation: { id: "channel-2", kind: "channel" },
        },
        createdAt: 2000,
        updatedAt: 2000,
      }),
    );
    await store.revokeBinding({ bindingId: "binding-1", revokedAt: 3000 });

    await expect(store.findActiveDefaultAgentAssignments()).resolves.toEqual([
      expect.objectContaining({ id: "profile-default" }),
    ]);
    await expect(store.findActiveBindings()).resolves.toEqual([
      expect.objectContaining({ id: "binding-2" }),
    ]);
  });

  it("reads and lazily rewrites pre-merge default Agent assignments", async () => {
    const store = await createStore();
    const db = stateDbs.at(-1)!.raw;
    const channel = buildBinding().channel;
    db.prepare(
      `INSERT INTO messaging_default_agent_assignments
       (assignment_id, scope_kind, scope_key, channel_kind, backend, thread_id, status, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy",
      "conversation",
      "conversation:telegram:dm::chat-1",
      "telegram",
      "codex",
      "agent-legacy",
      "active",
      1000,
      2000,
      JSON.stringify({
        id: "legacy",
        scopeKind: "conversation",
        backend: "codex",
        threadId: "agent-legacy",
        channelKind: "telegram",
        channel,
        createdAt: 1000,
        updatedAt: 2000,
        routingState: { opaque: { apiToken: "not-retained" } },
      }),
    );

    await expect(store.findActiveDefaultAgentAssignments()).resolves.toEqual([
      {
        id: "legacy",
        scope: { kind: "conversation", channel },
        target: {
          kind: "agent",
          backend: "codex",
          threadId: "agent-legacy",
        },
        createdAt: 1000,
        updatedAt: 2000,
      },
    ]);
    await store.revokeDefaultAgentAssignment({
      assignmentId: "legacy",
      revokedAt: 3000,
    });
    const payload = JSON.parse(
      (db.prepare(
        "SELECT payload FROM messaging_default_agent_assignments WHERE assignment_id = 'legacy'",
      ).get() as { payload: string }).payload,
    );
    expect(payload).toMatchObject({
      scope: { kind: "conversation" },
      target: { kind: "agent", threadId: "agent-legacy" },
      revokedAt: 3000,
    });
    expect(payload).not.toHaveProperty("routingState");
  });

  it("resolves the most specific active default Agent assignment", async () => {
    const store = await createStore();
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "profile-default",
        scope: { kind: "profile" },
        target: { kind: "agent", backend: "codex", threadId: "profile-agent" },
      }),
    );
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "provider-default",
        scope: { kind: "provider", channel: "telegram" },
        target: { kind: "agent", backend: "codex", threadId: "provider-agent" },
        createdAt: 1100,
        updatedAt: 1100,
      }),
    );
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "conversation-default",
        target: {
          kind: "agent",
          backend: "codex",
          threadId: "conversation-agent",
        },
        createdAt: 1200,
        updatedAt: 1200,
      }),
    );

    await expect(
      store.findActiveDefaultAgentAssignmentForChannel(buildBinding().channel),
    ).resolves.toMatchObject({
      id: "conversation-default",
      target: { threadId: "conversation-agent" },
    });

    await store.revokeDefaultAgentAssignment({
      assignmentId: "conversation-default",
      revokedAt: 1300,
    });

    await expect(
      store.findActiveDefaultAgentAssignmentForChannel(buildBinding().channel),
    ).resolves.toMatchObject({
      id: "provider-default",
      target: { threadId: "provider-agent" },
    });
  });

  it("routes a Settings-selected Slack channel ahead of the provider default", async () => {
    const store = await createStore();
    const channel = {
      channel: "slack" as const,
      conversation: {
        id: "C0BN6UXFREE",
        kind: "channel" as const,
        title: "p-pwragent-testing",
        workspaceId: "T1",
      },
    };
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "slack-provider-default",
        scope: { kind: "provider", channel: "slack" },
        target: {
          kind: "agent",
          backend: "codex",
          threadId: "provider-agent",
        },
      }),
    );
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "slack-channel-default",
        scope: { kind: "conversation", channel },
        target: {
          kind: "agent",
          backend: "codex",
          threadId: "channel-agent",
        },
        createdAt: 1100,
        updatedAt: 1100,
      }),
    );

    await expect(store.findActiveDefaultAgentAssignmentForChannel(channel))
      .resolves.toMatchObject({
        id: "slack-channel-default",
        target: { threadId: "channel-agent" },
      });
  });

  it("replaces active default Agent assignments within the same scope", async () => {
    const store = await createStore();
    await store.upsertDefaultAgentAssignment(buildDefaultAgentAssignment());
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "default-agent-2",
        target: { kind: "agent", backend: "codex", threadId: "agent-thread-2" },
        createdAt: 2000,
        updatedAt: 2000,
      }),
    );

    await expect(
      store.findActiveDefaultAgentAssignmentForChannel(buildBinding().channel),
    ).resolves.toMatchObject({
      id: "default-agent-2",
      target: { threadId: "agent-thread-2" },
    });
    await expect(store.getDefaultAgentAssignment("default-agent-1")).resolves
      .toMatchObject({
        revokedAt: 2000,
      });
  });

  it("resolves parent and workspace defaults in specificity order", async () => {
    const store = await createStore();
    const channel = {
      channel: "discord" as const,
      conversation: {
        id: "thread-1",
        kind: "thread" as const,
        parentId: "legacy-thread-parent",
        parentConversationId: "channel-1",
        workspaceId: "guild-1",
      },
    };
    for (const assignment of [
      buildDefaultAgentAssignment({
        id: "workspace-default",
        scope: { kind: "workspace", channel: "discord", workspaceId: "guild-1" },
        target: { kind: "agent", backend: "codex", threadId: "workspace-agent" },
      }),
      buildDefaultAgentAssignment({
        id: "parent-default",
        scope: { kind: "parent", channel: "discord", conversationId: "channel-1" },
        target: { kind: "agent", backend: "codex", threadId: "parent-agent" },
      }),
      buildDefaultAgentAssignment({
        id: "exact-default",
        scope: { kind: "conversation", channel },
        target: { kind: "agent", backend: "codex", threadId: "exact-agent" },
      }),
    ]) {
      await store.upsertDefaultAgentAssignment(assignment);
    }

    await expect(store.findActiveDefaultAgentAssignmentsForChannel(channel))
      .resolves.toMatchObject([
        { id: "exact-default" },
        { id: "parent-default" },
        { id: "workspace-default" },
      ]);
  });

  it("inherits a parent channel conversation default in a child thread", async () => {
    const store = await createStore();
    const parentChannel = {
      channel: "slack" as const,
      conversation: {
        id: "C012SEARCH",
        kind: "channel" as const,
        workspaceId: "T012WORKSPACE",
      },
    };
    const threadChannel = {
      channel: "slack" as const,
      conversation: {
        id: "C012SEARCH",
        kind: "thread" as const,
        parentId: "1786655046.300089",
        parentConversationId: "C012SEARCH",
        workspaceId: "T012WORKSPACE",
      },
    };
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "parent-channel-default",
        scope: { kind: "conversation", channel: parentChannel },
        target: {
          kind: "agent",
          backend: "codex",
          threadId: "parent-channel-agent",
        },
      }),
    );

    await expect(store.findActiveDefaultAgentAssignmentsForChannel(threadChannel))
      .resolves.toMatchObject([
        {
          id: "parent-channel-default",
          target: { threadId: "parent-channel-agent" },
        },
      ]);
  });

  it("preserves Discord parent identity when inheriting a channel default", async () => {
    const store = await createStore();
    const parentChannel = {
      channel: "discord" as const,
      conversation: {
        id: "parent-channel-1",
        kind: "channel" as const,
        parentId: "guild-1",
        workspaceId: "guild-1",
      },
    };
    const threadChannel = {
      channel: "discord" as const,
      conversation: {
        id: "thread-channel-1",
        kind: "thread" as const,
        parentConversationId: "parent-channel-1",
        parentConversationParentId: "guild-1",
        parentId: "guild-1",
        workspaceId: "guild-1",
      },
    };
    await store.upsertDefaultAgentAssignment(
      buildDefaultAgentAssignment({
        id: "discord-parent-channel-default",
        scope: { kind: "conversation", channel: parentChannel },
        target: {
          kind: "agent",
          backend: "codex",
          threadId: "discord-parent-channel-agent",
        },
      }),
    );

    await expect(store.findActiveDefaultAgentAssignmentsForChannel(threadChannel))
      .resolves.toMatchObject([
        {
          id: "discord-parent-channel-default",
          target: { threadId: "discord-parent-channel-agent" },
        },
      ]);
  });

  it("enforces one active assignment per scope in the database", async () => {
    const store = await createStore();
    await store.upsertDefaultAgentAssignment(buildDefaultAgentAssignment());
    const db = stateDbs.at(-1)!.raw;

    expect(() =>
      db.prepare(
        `INSERT INTO messaging_default_agent_assignments
         (assignment_id, scope_kind, scope_key, channel_kind, backend, thread_id, status, created_at, updated_at, payload)
         SELECT 'duplicate', scope_kind, scope_key, channel_kind, backend, 'other-agent', 'active', 2000, 2000, '{}'
         FROM messaging_default_agent_assignments
         WHERE assignment_id = 'default-agent-1'`,
      ).run()
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("persists pending skill selections on bindings", async () => {
    const store = await createStore();
    await store.upsertBinding(
      buildBinding({
        pendingSkillSelection: {
          cwd: "/repo/pwragent",
          description: "Create implementation plans",
          name: "ce:plan",
          path: "/skills/ce-plan/SKILL.md",
          selectedActorId: "user-1",
          selectedAt: 1000,
        },
      }),
    );

    await expect(store.getBinding("binding-1")).resolves.toMatchObject({
      pendingSkillSelection: {
        name: "ce:plan",
        path: "/skills/ce-plan/SKILL.md",
      },
    });
  });

  it("sweeps binding and channel state when a binding is revoked", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding());
    await store.upsertPendingIntent(buildPendingIntent());
    await store.upsertPendingIntent(
      buildPendingIntent({
        id: "channel-intent",
        bindingId: undefined,
        channel: buildBinding().channel,
      }),
    );
    await store.upsertPendingIntent(
      buildPendingIntent({
        id: "other-channel-intent",
        bindingId: undefined,
        channel: {
          channel: "telegram",
          conversation: {
            id: "other-chat",
            kind: "dm",
          },
        },
      }),
    );
    await store.upsertCallbackHandle(buildCallbackHandle());
    await store.upsertCallbackHandle(
      buildCallbackHandle({
        id: "other-callback",
        bindingId: "binding-2",
        handle: "tg:other",
      }),
    );

    await store.revokeBinding({ bindingId: "binding-1", revokedAt: 3000 });

    await expect(store.getPendingIntent("intent-1", { now: 1500 })).resolves
      .toBeUndefined();
    await expect(store.getPendingIntent("channel-intent", { now: 1500 })).resolves
      .toBeUndefined();
    await expect(
      store.getPendingIntent("other-channel-intent", { now: 1500 }),
    ).resolves.toMatchObject({
      id: "other-channel-intent",
    });
    await expect(store.getCallbackHandle("callback-1", { now: 1500 })).resolves
      .toBeUndefined();
    await expect(store.getCallbackHandle("other-callback", { now: 1500 })).resolves
      .toMatchObject({
        id: "other-callback",
    });
  });

  it("deletes pending intents scoped to a thread", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding({ id: "binding-1", threadId: "thread-1" }));
    await store.upsertBinding(buildBinding({ id: "binding-2", threadId: "thread-2" }));
    await store.upsertPendingIntent(
      buildPendingIntent({
        id: "intent-binding",
        bindingId: "binding-1",
      }),
    );
    await store.upsertPendingIntent(
      buildPendingIntent({
        id: "intent-request",
        bindingId: undefined,
        intent: {
          id: "approval-thread-1",
          kind: "single_select",
          createdAt: 1000,
          prompt: "Choose",
          choices: [{ id: "choice-a", label: "Choice A" }],
          requestContext: {
            backend: "codex",
            method: "approval/request",
            threadId: "thread-1",
            requestId: "request-1",
          },
        },
      }),
    );
    await store.upsertPendingIntent(
      buildPendingIntent({
        id: "intent-other-thread",
        bindingId: "binding-2",
      }),
    );

    await expect(
      store.deletePendingIntentsForThread({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual(["intent-binding", "intent-request"]);
    await expect(store.getPendingIntent("intent-binding")).resolves.toBeUndefined();
    await expect(store.getPendingIntent("intent-request")).resolves.toBeUndefined();
    await expect(store.getPendingIntent("intent-other-thread", { now: 1500 })).resolves
      .toBeDefined();
  });

  it("finds active bindings scoped to a backend", async () => {
    const store = await createStore();
    await store.upsertBinding(buildBinding({ id: "binding-codex" }));
    await store.upsertBinding(
      buildBinding({
        id: "binding-grok",
        backend: "acp:grok",
        channel: {
          channel: "telegram",
          conversation: { id: "chat-grok", kind: "dm" },
        },
        threadId: "thread-grok",
      }),
    );
    await store.upsertBinding(
      buildBinding({
        id: "binding-legacy",
        backend: undefined as unknown as "codex",
        channel: {
          channel: "telegram",
          conversation: { id: "chat-legacy", kind: "dm" },
        },
        threadId: "thread-legacy",
      }),
    );
    await store.revokeBinding({ bindingId: "binding-grok", revokedAt: 3000 });

    await expect(
      store.findActiveBindingsForBackend({ backend: "codex" }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "binding-codex" }),
      expect.objectContaining({ id: "binding-legacy" }),
    ]);
  });

  it("round-trips monitor state and monitor surface on bindings", async () => {
    const store = await createStore();
    await store.upsertBinding(
      buildBinding({
        monitor: {
          enabled: true,
          intervalMs: 60_000,
          lastRenderedAt: 2000,
          pinnedThreadLimit: 5,
          recentThreadLimit: 10,
          showLastResponseSnippet: true,
          showStatusLine: true,
          updatedAt: 2000,
        },
        monitorSurface: {
          channel: "telegram",
          id: "monitor-message-1",
          state: {
            opaque: {
              chatId: 123,
              messageId: 456,
              apiToken: "secret-token",
            },
          },
        },
        preferences: {
          executionMode: "full-access",
          model: "gpt-5.4",
          reasoningEffort: "high",
          updatedAt: 1500,
        },
        statusSurface: {
          channel: "telegram",
          id: "status-message-1",
        },
      }),
    );

    await expect(store.getBinding("binding-1")).resolves.toMatchObject({
      monitor: {
        enabled: true,
        intervalMs: 60_000,
        lastRenderedAt: 2000,
        pinnedThreadLimit: 5,
        recentThreadLimit: 10,
        showLastResponseSnippet: true,
        showStatusLine: true,
      },
      monitorSurface: {
        channel: "telegram",
        id: "monitor-message-1",
        state: {
          opaque: {
            chatId: 123,
            messageId: 456,
            apiToken: "[REDACTED]",
          },
        },
      },
      preferences: {
        executionMode: "full-access",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      statusSurface: {
        id: "status-message-1",
      },
    });
  });

  it("round-trips channel monitor subscriptions", async () => {
    const store = await createStore();
    await store.upsertMonitorSubscription(
      buildMonitorSubscription({
        monitor: {
          enabled: true,
          intervalMs: 60_000,
          lastRenderedAt: 2000,
          pinnedThreadLimit: 10,
          recentThreadLimit: 5,
          showLastResponseSnippet: true,
          showStatusLine: true,
          updatedAt: 2000,
        },
        monitorSurface: {
          channel: "telegram",
          id: "monitor-message-1",
          state: {
            opaque: {
              chatId: 123,
              apiToken: "secret-token",
            },
          },
        },
      }),
    );

    await expect(
      store.findActiveMonitorSubscriptionForChannel(buildMonitorSubscription().channel),
    ).resolves.toMatchObject({
      id: "monitor:telegram:dm::chat-1",
      monitor: {
        enabled: true,
        intervalMs: 60_000,
        lastRenderedAt: 2000,
        pinnedThreadLimit: 10,
        recentThreadLimit: 5,
        showLastResponseSnippet: true,
        showStatusLine: true,
      },
      monitorSurface: {
        id: "monitor-message-1",
        state: {
          opaque: {
            chatId: 123,
            apiToken: "[REDACTED]",
          },
        },
      },
    });
    await expect(
      store.findActiveMonitorSubscriptionsForChannelKind({ channel: "telegram" }),
    ).resolves.toHaveLength(1);

    await store.revokeMonitorSubscription({
      subscriptionId: "monitor:telegram:dm::chat-1",
      revokedAt: 3000,
    });
    await expect(
      store.findActiveMonitorSubscriptionForChannel(buildMonitorSubscription().channel),
    ).resolves.toBeUndefined();
  });

  it("repairs a missing monitor subscription table on reopen", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-sqlite-msg-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "state.db");
    const initialDb = StateDb.open(dbPath);
    stateDbs.push(initialDb);

    initialDb.raw.exec("DROP TABLE monitor_subscriptions");
    initialDb.raw.pragma("user_version = 4");
    initialDb.close();
    stateDbs.pop();

    const reopenedDb = StateDb.open(dbPath);
    stateDbs.push(reopenedDb);
    const store = new SqliteMessagingStore(reopenedDb);

    await expect(
      store.findActiveMonitorSubscriptionsForChannelKind({ channel: "telegram" }),
    ).resolves.toEqual([]);
    await expect(
      store.findActiveMonitorSubscriptionForChannel(buildMonitorSubscription().channel),
    ).resolves.toBeUndefined();
  });

  it("can delete callback handles for a binding without revoking it", async () => {
    const store = await createStore();
    await store.upsertCallbackHandle(buildCallbackHandle());
    await store.upsertCallbackHandle(
      buildCallbackHandle({
        id: "other-callback",
        bindingId: "binding-2",
        handle: "tg:other",
      }),
    );

    await expect(
      store.deleteCallbackHandlesForBinding({ bindingId: "binding-1" }),
    ).resolves.toEqual(["callback-1"]);
    await expect(store.getCallbackHandle("callback-1", { now: 1500 })).resolves
      .toBeUndefined();
    await expect(store.getCallbackHandle("other-callback", { now: 1500 })).resolves
      .toMatchObject({
        id: "other-callback",
      });
  });

  it("persists managed topics, thread-topic links, and cleanup proposals", async () => {
    const store = await createStore();

    await store.upsertManagedTopic(buildManagedTopic());
    await store.upsertThreadTopicLink(buildTopicLink());
    await store.upsertTopicCleanupProposal(buildCleanupProposal());

    await expect(
      store.findManagedTopicByConversation({
        channel: "telegram",
        supergroupId: "-1001",
        topicId: "100",
      }),
    ).resolves.toMatchObject({
      id: "topic:telegram:-1001:100",
      source: "owned",
    });
    await expect(
      store.findThreadTopicLink({
        backend: "codex",
        channel: "telegram",
        supergroupId: "-1001",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      topicRecordId: "topic:telegram:-1001:100",
    });
    await expect(store.getTopicCleanupProposal("proposal-1")).resolves.toMatchObject({
      status: "pending",
      items: [expect.objectContaining({ action: "close" })],
    });
    await expect(store.readSnapshot()).resolves.toMatchObject({
      topics: {
        "topic:telegram:-1001:100": expect.objectContaining({
          source: "owned",
        }),
      },
      topicLinks: {
        "topic-link:telegram:-1001:codex:thread-1": expect.objectContaining({
          threadId: "thread-1",
        }),
      },
      topicCleanupProposals: {
        "proposal-1": expect.objectContaining({
          status: "pending",
        }),
      },
    });
  });

  it("atomically preserves newer managed-topic state over an old observation", async () => {
    const store = await createStore();
    await store.upsertManagedTopic(buildManagedTopic({
      closedAt: 1_001,
      lifecycle: "closed",
      updatedAt: 1_001,
    }));

    await expect(store.mergeManagedTopicObservation(buildManagedTopic({
      lastObservedAt: 1_000,
      lifecycle: "open",
      source: "observed",
      title: "Stale observed title",
      updatedAt: 1_000,
    }))).resolves.toMatchObject({
      changed: true,
      topic: {
        closedAt: 1_001,
        lifecycle: "closed",
        source: "owned",
        title: "PwrAgent",
        updatedAt: 1_001,
      },
    });
  });
});
