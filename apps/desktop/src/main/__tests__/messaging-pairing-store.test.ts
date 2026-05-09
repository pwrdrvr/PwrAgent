import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessagingPairingStore } from "../messaging/messaging-pairing-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: MessagingPairingStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-pairing-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new MessagingPairingStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("MessagingPairingStore", () => {
  it("matches pending tokens without storing the raw token", () => {
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWX";
    const entry = store.create({
      token,
      platform: "telegram",
      instanceId: "default",
      scope: "user_dm",
      generatedAt: 1_000,
      expiresAt: 2_000,
    });

    expect(
      store.findMatchingPending({
        token,
        platform: "telegram",
        instanceId: "default",
        now: 1_500,
      }),
    ).toMatchObject({ id: entry.id, status: "pending" });

    const row = stateDb.raw
      .prepare("SELECT token_hmac, payload FROM messaging_pairing_tokens WHERE entry_id = ?")
      .get(entry.id) as { token_hmac: string; payload: string };
    expect(row.token_hmac).not.toContain(token);
    expect(row.payload).not.toContain(token);
  });

  it("expires tokens and prevents replay after observation", () => {
    const token = "ABCDEFGHJKLMNPQRSTUVWXYZ1234567";
    const entry = store.create({
      token,
      platform: "discord",
      instanceId: "default",
      scope: "bucket",
      generatedAt: 1_000,
      expiresAt: 2_000,
    });

    expect(
      store.findMatchingPending({
        token,
        platform: "discord",
        instanceId: "default",
        now: 2_000,
      }),
    ).toBeUndefined();
    expect(store.get(entry.id)).toMatchObject({ status: "expired" });

    const replayToken = "abcdefghijkmnopqrstuvwxyz1234567";
    const replayEntry = store.create({
      token: replayToken,
      platform: "discord",
      instanceId: "default",
      scope: "bucket",
      generatedAt: 3_000,
      expiresAt: 4_000,
    });
    store.markObserved({
      entryId: replayEntry.id,
      observedAt: 3_100,
      actor: { id: "user-1", displayName: "Alice" },
      chat: { id: "guild-1", kind: "channel", bucketId: "guild-1" },
    });

    expect(
      store.findMatchingPending({
        token: replayToken,
        platform: "discord",
        instanceId: "default",
        now: 3_200,
      }),
    ).toBeUndefined();
    expect(store.get(replayEntry.id)).toMatchObject({
      status: "observed",
      observedActor: { id: "user-1", displayName: "Alice" },
    });
  });

  it("parameterizes token lookups", () => {
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWX";
    const entry = store.create({
      token,
      platform: "telegram",
      instanceId: "default",
      scope: "user_dm",
      generatedAt: 1_000,
      expiresAt: 2_000,
    });

    expect(
      store.findMatchingPending({
        token: "' OR 1=1 --",
        platform: "telegram",
        instanceId: "default",
        now: 1_500,
      }),
    ).toBeUndefined();
    expect(store.get(entry.id)).toMatchObject({ id: entry.id, status: "pending" });
  });
});
