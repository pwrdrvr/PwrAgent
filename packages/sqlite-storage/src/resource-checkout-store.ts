import Database from "better-sqlite3";
import type {
  CheckoutDomainRecord, CheckoutReceipt, CheckoutStore, CheckoutTransaction,
} from "@pwragent/owner-core/resource-checkout-storage";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled } from "./sqlite-write-metrics";

/** The store was created under another machine identity: a copied or cloned root. */
export class CheckoutStoreIdentityError extends Error {
  constructor() {
    super("The checkout store belongs to another machine identity.");
    this.name = "CheckoutStoreIdentityError";
  }
}

/**
 * `adoptIdentity` takes over a store created under another identity: the
 * operator chose to keep a copied root on this machine.
 */
export function openResourceCheckoutStore(
  path: string,
  identity: string,
  options?: { adoptIdentity?: boolean },
): CheckoutStore & { close(): void } {
  const db = new Database(path, { timeout: 2_000 });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkout_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkout_domains (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkout_receipts (
          actor TEXT NOT NULL, key TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (actor, key)
        ) WITHOUT ROWID;
      `);
      const saved = db.prepare("SELECT identity FROM checkout_identity WHERE singleton = 1").pluck().get();
      if (saved === undefined) db.prepare("INSERT INTO checkout_identity VALUES (1, ?)").run(identity);
      else if (saved !== identity) {
        if (!options?.adoptIdentity) throw new CheckoutStoreIdentityError();
        db.prepare("UPDATE checkout_identity SET identity = ? WHERE singleton = 1").run(identity);
      }
    }).immediate();
    if (isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db, dbPath: path });
    const read = db.prepare("SELECT record FROM checkout_domains WHERE id = ?").pluck();
    const list = db.prepare("SELECT record FROM checkout_domains ORDER BY id").pluck();
    const save = db.prepare(`
      INSERT INTO checkout_domains (id, canonical_key, record) VALUES (?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET record = excluded.record
    `);
    const receipt = db.prepare("SELECT receipt FROM checkout_receipts WHERE actor = ? AND key = ?").pluck();
    const recordReceipt = db.prepare("INSERT INTO checkout_receipts (actor, key, receipt) VALUES (?, ?, ?)");
    const tx: CheckoutTransaction = {
      read(id) {
        const record = read.get(id) as string | undefined;
        return record === undefined ? undefined : JSON.parse(record) as CheckoutDomainRecord;
      },
      list: () => (list.all() as string[]).map((row) => JSON.parse(row) as CheckoutDomainRecord),
      save: (record) => {
        const { canonicalKey, draftOwnerInstanceId, resourceId } = record.definition;
        const storageKey = draftOwnerInstanceId ? JSON.stringify([draftOwnerInstanceId, canonicalKey]) : canonicalKey;
        save.run(resourceId, storageKey, JSON.stringify(record));
      },
      receipt(actor, key) {
        const value = receipt.get(actor, key) as string | undefined;
        return value === undefined ? undefined : JSON.parse(value) as CheckoutReceipt;
      },
      recordReceipt: (actor, key, value) => { recordReceipt.run(actor, key, JSON.stringify(value)); },
    };
    return {
      change: (apply) => db.transaction(() => apply(tx)).immediate(),
      readAll: () => tx.list(), receipt: (actor, key) => tx.receipt(actor, key), close: () => { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
