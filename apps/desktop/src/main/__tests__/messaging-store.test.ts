import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingBrowseSessionRecord,
  MessagingCallbackHandleRecord,
  MessagingPendingIntentRecord,
} from "@pwragnt/shared";
import { MessagingStore } from "../messaging/core/messaging-store";

const tempDirs: string[] = [];

async function createStore(): Promise<{ filePath: string; store: MessagingStore }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-messaging-store-"));
  tempDirs.push(tempDir);
  const filePath = path.join(tempDir, "messaging-state.json");
  return {
    filePath,
    store: new MessagingStore(filePath),
  };
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
      choices: [
        {
          id: "choice-a",
          label: "Choice A",
        },
      ],
    },
    ...overrides,
  };
}

function buildBrowseSession(
  overrides: Partial<MessagingBrowseSessionRecord> = {},
): MessagingBrowseSessionRecord {
  return {
    id: "browse-1",
    allowedActorIds: ["user-1"],
    bindingId: "binding-1",
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    createdAt: 1000,
    updatedAt: 1000,
    expiresAt: 2000,
    launchAction: "resume_thread",
    mode: "recents",
    pageIndex: 0,
    pageSize: 5,
    selectedProject: {
      label: "PwrAgnt",
      directoryKey: "directory:pwragnt",
    },
    surface: {
      channel: "telegram",
      id: "message-1",
      state: {
        opaque: {
          chatId: 777,
          messageId: 123,
        },
      },
    },
    ...overrides,
  };
}

function buildCallbackHandle(
  overrides: Partial<MessagingCallbackHandleRecord> = {},
): MessagingCallbackHandleRecord {
  return {
    id: "callback-1",
    actionId: "browse:select:1",
    allowedActorIds: ["user-1"],
    bindingId: "binding-1",
    browseSessionId: "browse-1",
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    createdAt: 1000,
    updatedAt: 1000,
    expiresAt: 2000,
    handle: "tg:short",
    surface: {
      channel: "telegram",
      id: "message-1",
    },
    value: {
      backend: "codex",
      threadId: "thread-1",
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
});

describe("MessagingStore", () => {
  it("persists bindings and pending intents across store instances", async () => {
    const { filePath, store } = await createStore();
    await store.upsertBinding(buildBinding());
    await store.upsertPendingIntent(buildPendingIntent());
    await store.upsertBrowseSession(buildBrowseSession());
    await store.upsertCallbackHandle(buildCallbackHandle());

    const reloaded = new MessagingStore(filePath);

    await expect(reloaded.getBinding("binding-1")).resolves.toMatchObject({
      id: "binding-1",
      backend: "codex",
      threadId: "thread-1",
    });
    await expect(reloaded.getPendingIntent("intent-1", { now: 1500 })).resolves
      .toMatchObject({
        id: "intent-1",
        bindingId: "binding-1",
      });
    await expect(reloaded.getBrowseSession("browse-1", { now: 1500 })).resolves
      .toMatchObject({
        id: "browse-1",
        mode: "recents",
        selectedProject: {
          label: "PwrAgnt",
        },
      });
    await expect(
      reloaded.resolveCallbackHandle({
        actorId: "user-1",
        channel: buildBinding().channel,
        handle: "tg:short",
        now: 1500,
      }),
    ).resolves.toMatchObject({
      actionId: "browse:select:1",
      value: {
        threadId: "thread-1",
      },
    });
  });

  it("drops deprecated cached thread display and active turn data from bindings", async () => {
    const { filePath, store } = await createStore();
    await store.upsertBinding(
      buildBinding({
        activeTurn: {
          status: "working",
          turnId: "turn-1",
          updatedAt: 1000,
        },
        threadDisplay: {
          directoryPath: "/old/path",
          projectLabel: "Old Project",
          threadTitle: "Old cached title",
          worktreePath: "/old/worktree",
        },
      }),
    );

    await expect(store.getBinding("binding-1")).resolves.toEqual(
      expect.not.objectContaining({
        activeTurn: expect.anything(),
        threadDisplay: expect.anything(),
      }),
    );

    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        browseSessions: {},
        bindings: {
          "binding-1": buildBinding({
            activeTurn: {
              status: "working",
              turnId: "turn-1",
              updatedAt: 1000,
            },
            threadDisplay: {
              threadTitle: "Old cached title",
            },
          }),
        },
        callbackHandles: {},
        pendingIntents: {},
        deliveries: {},
      }),
      "utf8",
    );

    const reloaded = new MessagingStore(filePath);
    await expect(reloaded.getBinding("binding-1")).resolves.toEqual(
      expect.not.objectContaining({
        activeTurn: expect.anything(),
        threadDisplay: expect.anything(),
      }),
    );
  });

  it("finds active bindings by stable channel conversation and ignores revoked records", async () => {
    const { store } = await createStore();
    await store.upsertBinding(buildBinding());

    await expect(
      store.findActiveBindingForChannel({
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      }),
    ).resolves.toMatchObject({ id: "binding-1" });

    await store.revokeBinding({ bindingId: "binding-1", revokedAt: 3000 });

    await expect(
      store.findActiveBindingForChannel({
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("removes pending intents for a binding when the binding is revoked", async () => {
    const { store } = await createStore();
    await store.upsertBinding(buildBinding());
    await store.upsertPendingIntent(buildPendingIntent());
    await store.upsertBrowseSession(buildBrowseSession());
    await store.upsertCallbackHandle(buildCallbackHandle());

    await store.revokeBinding({ bindingId: "binding-1", revokedAt: 3000 });

    await expect(store.getPendingIntent("intent-1", { now: 1500 })).resolves
      .toBeUndefined();
    await expect(store.getBrowseSession("browse-1", { now: 1500 })).resolves
      .toBeUndefined();
    await expect(store.getCallbackHandle("callback-1", { now: 1500 })).resolves
      .toBeUndefined();
    await expect(store.getBinding("binding-1")).resolves.toMatchObject({
      revokedAt: 3000,
    });
  });

  it("ignores and cleans up expired pending intents and browse state without deleting active records", async () => {
    const { store } = await createStore();
    await store.upsertPendingIntent(buildPendingIntent({ id: "expired", expiresAt: 1500 }));
    await store.upsertPendingIntent(buildPendingIntent({ id: "active", expiresAt: 2500 }));
    await store.upsertBrowseSession(buildBrowseSession({ id: "expired-browse", expiresAt: 1500 }));
    await store.upsertBrowseSession(buildBrowseSession({ id: "active-browse", expiresAt: 2500 }));
    await store.upsertCallbackHandle(
      buildCallbackHandle({
        id: "expired-callback",
        browseSessionId: undefined,
        expiresAt: 1500,
      }),
    );
    await store.upsertCallbackHandle(
      buildCallbackHandle({
        id: "active-callback",
        browseSessionId: undefined,
        expiresAt: 2500,
      }),
    );

    await expect(store.getPendingIntent("expired", { now: 2000 })).resolves
      .toBeUndefined();
    await expect(store.cleanupExpiredPendingIntents({ now: 2000 })).resolves.toEqual([
      "expired",
    ]);
    await expect(store.getPendingIntent("active", { now: 2000 })).resolves.toMatchObject({
      id: "active",
    });
    await expect(store.getBrowseSession("expired-browse", { now: 2000 })).resolves
      .toBeUndefined();
    await expect(store.cleanupExpiredBrowseSessions({ now: 2000 })).resolves.toEqual([
      "expired-browse",
    ]);
    await expect(store.getBrowseSession("active-browse", { now: 2000 })).resolves
      .toMatchObject({
        id: "active-browse",
      });
    await expect(store.getCallbackHandle("expired-callback", { now: 2000 })).resolves
      .toBeUndefined();
    await expect(store.cleanupExpiredCallbackHandles({ now: 2000 })).resolves.toEqual([
      "expired-callback",
    ]);
    await expect(store.getCallbackHandle("active-callback", { now: 2000 })).resolves
      .toMatchObject({
        id: "active-callback",
      });
  });

  it("fails callback handle resolution closed for wrong actor, channel, or expiry", async () => {
    const { store } = await createStore();
    await store.upsertCallbackHandle(buildCallbackHandle());

    await expect(
      store.resolveCallbackHandle({
        actorId: "other-user",
        channel: buildBinding().channel,
        handle: "tg:short",
        now: 1500,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.resolveCallbackHandle({
        actorId: "user-1",
        channel: {
          channel: "telegram",
          conversation: {
            id: "other-chat",
            kind: "dm",
          },
        },
        handle: "tg:short",
        now: 1500,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.resolveCallbackHandle({
        actorId: "user-1",
        channel: buildBinding().channel,
        handle: "tg:short",
        now: 2500,
      }),
    ).resolves.toBeUndefined();
  });

  it("migrates malformed and older-version store data to safe defaults", async () => {
    const { filePath } = await createStore();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 0,
        bindings: {
          valid: buildBinding({ id: "valid" }),
          invalid: {
            id: "invalid",
          },
        },
        browseSessions: {
          valid: buildBrowseSession({ id: "valid-browse" }),
          invalid: {
            id: "invalid-browse",
          },
        },
        callbackHandles: {
          valid: buildCallbackHandle({ id: "valid-callback" }),
          invalid: {
            id: "invalid-callback",
          },
        },
        pendingIntents: {
          valid: buildPendingIntent({ id: "valid-intent" }),
          invalid: {
            id: "invalid-intent",
          },
        },
        deliveries: {
          valid: {
            id: "delivery-1",
            channel: "telegram",
            outcome: "presented",
            deliveredAt: 1000,
          },
        },
      }),
      "utf8",
    );

    const store = new MessagingStore(filePath);

    await expect(store.readSnapshot()).resolves.toMatchObject({
      version: 2,
      bindings: {
        valid: {
          id: "valid",
        },
      },
      browseSessions: {
        valid: {
          id: "valid-browse",
        },
      },
      callbackHandles: {
        valid: {
          id: "valid-callback",
        },
      },
      pendingIntents: {
        valid: {
          id: "valid-intent",
        },
      },
      deliveries: {
        valid: {
          id: "delivery-1",
        },
      },
    });
  });

  it("serializes concurrent writes without dropping bindings", async () => {
    const { store } = await createStore();

    await Promise.all([
      store.upsertBinding(buildBinding({ id: "binding-a", threadId: "thread-a" })),
      store.upsertBinding(buildBinding({ id: "binding-b", threadId: "thread-b" })),
    ]);

    await expect(store.readSnapshot()).resolves.toMatchObject({
      bindings: {
        "binding-a": {
          threadId: "thread-a",
        },
        "binding-b": {
          threadId: "thread-b",
        },
      },
    });
  });

  it("redacts secret-like adapter state before writing to disk", async () => {
    const { filePath, store } = await createStore();
    await store.upsertBinding(
      buildBinding({
        pinnedStatusSurface: {
          channel: "telegram",
          id: "pin-1",
          state: {
            opaque: {
              token: "status-secret",
            },
          },
        },
        routingState: {
          opaque: {
            botToken: "telegram-secret-token",
            nested: {
              api_key: "api-secret",
              safe: "kept",
            },
          },
        },
      }),
    );
    await store.upsertCallbackHandle(
      buildCallbackHandle({
        value: {
          authorization: "callback-secret",
          safe: "kept-callback",
        },
      }),
    );

    const raw = await readFile(filePath, "utf8");

    expect(raw).not.toContain("telegram-secret-token");
    expect(raw).not.toContain("api-secret");
    expect(raw).not.toContain("status-secret");
    expect(raw).not.toContain("callback-secret");
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain("kept");
    expect(raw).toContain("kept-callback");
  });

  it("does not trust mutable usernames as authorization identity", async () => {
    const { store } = await createStore();
    await store.upsertBinding(
      buildBinding({
        authorizedActorIds: ["stable-user-id"],
        displayName: "Mutable Username",
      }),
    );

    const binding = await store.getBinding("binding-1");

    expect(binding?.authorizedActorIds).toEqual(["stable-user-id"]);
    expect(binding?.authorizedActorIds).not.toContain("Mutable Username");
  });
});
