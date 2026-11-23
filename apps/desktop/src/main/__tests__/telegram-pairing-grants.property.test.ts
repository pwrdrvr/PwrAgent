import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { telegramBotAccountId } from "@pwragent/shared/messaging-id-validation";
import { MessagingPairingStore } from "../storage/messaging-pairing-store";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const originalAccount = "123456";
const replacementAccount = "654321";
const contact = { id: "42", displayName: "Fixture Contact" };

function observe(store: MessagingPairingStore, instanceId = `account:${originalAccount}`) {
  const entry = store.create({
    token: randomUUID(),
    platform: "telegram",
    instanceId,
    scope: "user_dm",
    generatedAt: 1_000,
    expiresAt: 2_000,
  });
  store.markObserved({
    entryId: entry.id,
    observedAt: 1_100,
    actor: contact,
    chat: { id: contact.id, kind: "dm" },
  });
  return entry.id;
}

function approve(store: MessagingPairingStore, db: StateDb, entryId: string) {
  return store.approveTelegramPairing({
    entryId,
    contact,
    now: 1_200,
    resolveCurrentAccountId: () => {
      expect(db.raw.inTransaction).toBe(true);
      return telegramBotAccountId(db.getSecret("telegramBotToken")?.toString());
    },
  });
}

it("publishes a Telegram pairing grant only for the bot that observed it across credential writes", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("approve", "replace", "rotate", "clear", "revoke"), { minLength: 1, maxLength: 16 }),
    (operations) => {
      const fixture = createTempStateDb("telegram-grant-model-");
      const db = StateDb.open(fixture.dbPath);
      const secretWriter = StateDb.open(fixture.dbPath);
      try {
        const store = new MessagingPairingStore(db);
        const secondStore = new MessagingPairingStore(secretWriter);
        db.setSecret("telegramBotToken", Buffer.from(`${originalAccount}:first`));
        let activeAccount: string | undefined = originalAccount;
        let hasGrant = false;
        for (const operation of operations) {
          if (operation === "approve") {
            const id = observe(store);
            const result = approve(store, db, id);
            if (activeAccount === originalAccount) {
              expect(result).toMatchObject({ entry: { id, status: "consumed" }, added: !hasGrant });
              hasGrant = true;
            } else {
              expect(result).toBe(activeAccount ? "different-bot" : "unavailable");
              expect(secondStore.get(id)?.status).toBe("observed");
            }
          } else if (operation === "replace") {
            // Bootstrap may save the new credential through a separate handle.
            secretWriter.setSecret("telegramBotToken", Buffer.from(`${replacementAccount}:new`));
            activeAccount = replacementAccount;
          } else if (operation === "rotate") {
            db.setSecret("telegramBotToken", Buffer.from(`${originalAccount}:rotated`));
            activeAccount = originalAccount;
          } else if (operation === "clear") {
            secretWriter.deleteSecret("telegramBotToken");
            activeAccount = undefined;
          } else {
            secondStore.revokeTelegramGrant({ accountId: originalAccount, kind: "users", contactId: contact.id });
            hasGrant = false;
          }
          expect(secondStore.readTelegramGrants(originalAccount).users).toEqual(hasGrant ? [contact] : []);
          expect(secondStore.readTelegramGrants(replacementAccount).users).toEqual([]);
        }
        expect(approve(store, db, observe(store, "default"))).toBe(activeAccount ? "different-bot" : "unavailable");
      } finally {
        secretWriter.close();
        db.close();
        removeTempStateDbDir(fixture.tempDir);
      }
    },
  ), { numRuns: 40, examples: [[["rotate", "approve", "replace", "revoke", "rotate"]]] });
});

it.each([false, true])("isolates an observed Telegram grant across bot replacement (approve first: %s)", (approveFirst) => {
  const fixture = createTempStateDb("telegram-grant-order-");
  const db = StateDb.open(fixture.dbPath);
  const secretWriter = StateDb.open(fixture.dbPath);
  try {
    const store = new MessagingPairingStore(db);
    db.setSecret("telegramBotToken", Buffer.from(`${originalAccount}:first`));
    const entryId = observe(store);
    if (approveFirst) expect(approve(store, db, entryId)).toMatchObject({ added: true });
    secretWriter.setSecret("telegramBotToken", Buffer.from(`${replacementAccount}:new`));
    if (!approveFirst) expect(approve(store, db, entryId)).toBe("different-bot");
    expect(store.readTelegramGrants(replacementAccount).users).toEqual([]);
    expect(store.readTelegramGrants(originalAccount).users).toEqual(approveFirst ? [contact] : []);
  } finally {
    secretWriter.close();
    db.close();
    removeTempStateDbDir(fixture.tempDir);
  }
});

it("commits approval and consumption together and bounds access management writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("telegram-grant-budget-");
  const db = StateDb.open(fixture.dbPath);
  try {
    const store = new MessagingPairingStore(db);
    db.setSecret("telegramBotToken", Buffer.from(`${originalAccount}:first`));
    const entryId = observe(store);
    const { writes: approval } = await measureSqliteWrites(() => approve(store, db, entryId));
    expectSqliteWriteBudget({
      scenario: "telegram-pairing-grant-approve",
      note: "Upsert the bot-scoped grant and consume the observed request in one transaction.",
      writes: approval,
    });
    const { writes: dismissal } = await measureSqliteWrites(() => store.dismissTelegramGrantWarning(originalAccount, contact.id));
    expectSqliteWriteBudget({
      scenario: "telegram-pairing-grant-dismiss-warning",
      note: "Update the warning setting for one paired Telegram user.",
      writes: dismissal,
    });
    const { writes: revocation } = await measureSqliteWrites(() =>
      store.revokeTelegramGrant({ accountId: originalAccount, kind: "users", contactId: contact.id }));
    expectSqliteWriteBudget({
      scenario: "telegram-pairing-grant-revoke",
      note: "Remove one bot-scoped Telegram pairing grant.",
      writes: revocation,
    });
  } finally {
    db.close();
    removeTempStateDbDir(fixture.tempDir);
    vi.unstubAllEnvs();
  }
});
