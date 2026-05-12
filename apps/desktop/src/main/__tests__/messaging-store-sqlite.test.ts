import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingCallbackHandleRecord,
  MessagingMonitorSubscriptionRecord,
  MessagingPendingIntentRecord,
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
        backend: "grok",
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
});
