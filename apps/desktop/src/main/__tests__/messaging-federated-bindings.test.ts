import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  federatedThreadRefForMessagingBinding,
  messagingBindingTargetsRemoteInstance,
} from "../messaging/federated-messaging-routing";

let stateDb: StateDb;
let store: SqliteMessagingStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-msg-federation-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteMessagingStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("messaging federated bindings", () => {
  it("finds active bindings by full federated thread identity", async () => {
    const federatedThread = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "child_one",
      threadId: "thread-1",
    });
    const binding: MessagingBindingRecord = {
      id: "binding-1",
      backend: "codex",
      threadId: "thread-1",
      federatedThread,
      authorizedActorIds: ["user-1"],
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
      createdAt: 1_000,
      updatedAt: 1_000,
    };

    await store.upsertBinding(binding);
    await store.upsertBinding({
      ...binding,
      id: "binding-local",
      channel: {
        channel: "discord",
        conversation: { id: "channel-1", kind: "channel" },
      },
      federatedThread: undefined,
    });

    await expect(
      store.findActiveBindingsForFederatedThread(federatedThread),
    ).resolves.toMatchObject([
      {
        id: "binding-1",
        federatedThread: {
          target: { scope: "remote", instanceId: "child_one" },
          threadId: "thread-1",
        },
      },
    ]);
    await expect(
      store.findActiveBindingsForFederatedThread({
        ...federatedThread,
        target: { scope: "remote", instanceId: "child_two" },
      }),
    ).resolves.toEqual([]);
  });

  it("normalizes messaging bindings to local or remote federation refs", () => {
    const localBinding: MessagingBindingRecord = {
      id: "binding-local",
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["user-1"],
      channel: {
        channel: "telegram",
        conversation: { id: "chat-1", kind: "dm" },
      },
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const remoteBinding: MessagingBindingRecord = {
      ...localBinding,
      id: "binding-remote",
      federatedThread: buildFederatedThreadRef({
        backend: "codex",
        instanceId: "child_one",
        threadId: "thread-1",
      }),
    };

    expect(federatedThreadRefForMessagingBinding(localBinding)).toMatchObject({
      target: { scope: "local" },
      threadId: "thread-1",
    });
    expect(messagingBindingTargetsRemoteInstance(localBinding)).toBe(false);
    expect(federatedThreadRefForMessagingBinding(remoteBinding)).toMatchObject({
      target: { scope: "remote", instanceId: "child_one" },
      threadId: "thread-1",
    });
    expect(messagingBindingTargetsRemoteInstance(remoteBinding)).toBe(true);
  });
});
