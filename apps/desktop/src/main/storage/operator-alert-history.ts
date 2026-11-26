import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
  NATIVE_ALERT_CATEGORIES,
  NATIVE_HISTORY_PHASES,
  TOAST_CATEGORIES,
  TOAST_HISTORY_PHASES,
  type NativeAlertObservation,
  type OperatorAlertHistory,
  type ToastHistoryObservation,
} from "../../shared/operator-alert-history";
import { getMainLogger } from "../log";
import { getAppStateDb, getAppStateMode } from "../state/app-state";

const CAPACITY = 512;
const BATCH_CAPACITY = 256;
const FLUSH_INTERVAL_MS = 5_000;
const TOAST_REPLAY_MS = 30_000;
const MAX_ID_LENGTH = 16_384;

const SALT_KEY = "operator_alert_history_salt";
const EVICTED_KEY = "operator_alert_history_evicted";
const DROPPED_KEY = "operator_alert_history_dropped";
const log = getMainLogger("pwragent:operator-alert-history");

type Observation = ToastHistoryObservation | NativeAlertObservation;
type PendingObservation = Observation & { at: number };
type Alert = OperatorAlertHistory["alerts"][number];
type StoredAlert = { sequence: number; category: unknown; surface: unknown; milestones: string };

function includes<T extends string>(values: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === "string" && values.some((value) => value === candidate);
}

function readMilestones(row: StoredAlert, phases: readonly (keyof Alert["milestones"])[]): Alert["milestones"] {
  const source = JSON.parse(row.milestones) as Record<string, unknown>;
  const milestones: Alert["milestones"] = {};
  for (const phase of phases) {
    const at = source?.[phase];
    if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) milestones[phase] = at;
  }
  return milestones;
}

function opensAlert(observation: Observation): boolean {
  return observation.surface === "native"
    ? observation.phase === "submitted" || observation.phase === "unsupported"
    : observation.phase === "queued" || (observation.phase === "displayed" && observation.standalone === true);
}

function toastEndedAt(milestones: Alert["milestones"]): number {
  return Math.max(milestones.dismissed ?? -Infinity, milestones.expired ?? -Infinity, milestones.withdrawn ?? -Infinity);
}

function appendBatch(db: Database, pending: readonly PendingObservation[], dropped: number): void {
  const readMeta = db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?");
  const addCount = db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER)
  `);
  const latest = db.prepare<[string], StoredAlert>(`
    SELECT sequence, category, surface, milestones FROM operator_alert_history
    WHERE correlation_key = ? ORDER BY sequence DESC LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO operator_alert_history(correlation_key, category, surface, milestones) VALUES (?, ?, ?, ?)
  `);
  const update = db.prepare("UPDATE operator_alert_history SET milestones = ? WHERE sequence = ?");
  const prune = db.prepare(`
    DELETE FROM operator_alert_history WHERE sequence <= (
      SELECT sequence FROM operator_alert_history ORDER BY sequence DESC LIMIT 1 OFFSET ?
    )
  `);

  db.transaction(() => {
    let salt = readMeta.get(SALT_KEY)?.value;
    if (!salt) {
      salt = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(SALT_KEY, salt);
    }
    let inserted = false;
    for (const observation of pending) {
      const { at, category, identity, phase, surface } = observation;
      const key = createHmac("sha256", salt).update(JSON.stringify([surface, category, identity])).digest("hex");
      const row = latest.get(key);
      const milestones = row ? readMilestones(row, surface === "native" ? NATIVE_HISTORY_PHASES : TOAST_HISTORY_PHASES) : {};
      const end = toastEndedAt(milestones);
      // A reused toast slot can start a new occurrence after its previous
      // card ended and the cross-window replay window elapsed.
      const reopen = surface !== "native" && Number.isFinite(end) && at > end + TOAST_REPLAY_MS;
      if (opensAlert(observation) && (!row || reopen)) {
        insert.run(key, category, surface, JSON.stringify({ [phase]: at }));
        inserted = true;
      } else if (row && (milestones[phase] === undefined || at < milestones[phase])) {
        milestones[phase] = at;
        update.run(JSON.stringify(milestones), row.sequence);
      }
    }
    if (inserted) {
      const { changes } = prune.run(CAPACITY);
      if (changes > 0) addCount.run(EVICTED_KEY, changes);
    }
    if (dropped > 0) addCount.run(DROPPED_KEY, dropped);
  }).immediate();
}

function readHistory(db: Database): OperatorAlertHistory {
  return db.transaction((): OperatorAlertHistory => {
    const readMeta = db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?");
    const rows = db.prepare<[number], StoredAlert>(`
      SELECT sequence, category, surface, milestones
      FROM operator_alert_history ORDER BY sequence DESC LIMIT ?
    `).all(CAPACITY);
    const alerts: Alert[] = [];
    for (const row of rows) {
      const { category, surface } = row;
      if (surface === "native" && includes(NATIVE_ALERT_CATEGORIES, category)) {
        alerts.push({ category, surface, milestones: readMilestones(row, NATIVE_HISTORY_PHASES) });
      } else if ((surface === "durable-toast" || surface === "transient-toast") && includes(TOAST_CATEGORIES, category)) {
        alerts.push({ category, surface, milestones: readMilestones(row, TOAST_HISTORY_PHASES) });
      }
    }
    return {
      version: 1,
      capacity: CAPACITY,
      evictedCount: Number(readMeta.get(EVICTED_KEY)?.value ?? 0),
      droppedObservationCount: Number(readMeta.get(DROPPED_KEY)?.value ?? 0),
      alerts,
    };
  })();
}

export class OperatorAlertHistoryRecorder {
  private readonly pending: PendingObservation[] = [];
  private timer?: NodeJS.Timeout;
  private dropped = 0;
  private reportedFailure = false;

  constructor(
    private readonly database: () => Database,
    private readonly now: () => number = Date.now,
    private readonly active: () => boolean = () => true,
  ) {}

  recordToast(input: unknown): void {
    if (!input || typeof input !== "object") return;
    const { identity, category, surface, phase, standalone } = input as Record<string, unknown>;
    if (typeof identity !== "string" || identity.length === 0 || identity.length > MAX_ID_LENGTH
      || !includes(TOAST_CATEGORIES, category)
      || (surface !== "durable-toast" && surface !== "transient-toast")
      || !includes(TOAST_HISTORY_PHASES, phase)) return;
    this.record({ identity, category, surface, phase, ...(standalone === true ? { standalone } : {}) });
  }

  recordNative(observation: NativeAlertObservation): void {
    this.record(observation);
  }

  private record(observation: Observation): void {
    if (!this.active()) return;
    if (this.pending.length === BATCH_CAPACITY) {
      this.flushBestEffort();
      if (this.pending.length === BATCH_CAPACITY) {
        this.dropped = Math.min(this.dropped + 1, Number.MAX_SAFE_INTEGER);
        return;
      }
    }
    // Keep free-form IDs (some include paths or provider text) out of the queue.
    const identity = createHash("sha256").update(observation.identity).digest("hex");
    this.pending.push({ ...observation, identity, at: this.now() });
    this.timer ??= setTimeout(() => this.flushBestEffort(), FLUSH_INTERVAL_MS).unref();
  }

  read(): OperatorAlertHistory {
    this.flush();
    return readHistory(this.database());
  }

  flushBestEffort(): void {
    try {
      this.flush();
    } catch {
      if (!this.reportedFailure) log.warn("Could not persist operator alert history");
      this.reportedFailure = true;
    }
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0 && this.dropped === 0) return;
    appendBatch(this.database(), this.pending, this.dropped);
    this.pending.length = 0;
    this.dropped = 0;
    this.reportedFailure = false;
  }
}

export const operatorAlertHistory = new OperatorAlertHistoryRecorder(
  () => {
    if (getAppStateMode() !== "active-profile") throw new Error("Operator alert history is unavailable");
    return getAppStateDb().raw;
  },
  Date.now,
  () => getAppStateMode() === "active-profile",
);
