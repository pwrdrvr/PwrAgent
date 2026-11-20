import type { BackendRateLimitSummary } from "@pwragent/shared/contracts/backend";

/**
 * Account plan limits for every provider (Codex, Claude, ACP agents), one
 * entry per provider, holding the account those limits describe.
 *
 * Providers report limits from several places at once: Codex's rolling
 * updates from each running turn and its account reads, each Claude CLI's
 * stream events and usage probes, Grok's billing reads. No reading says when
 * it was taken, so readings arrive out of order and at different ages. This
 * store merges each one window by window and only moves a value forward:
 *
 * - A window a reading leaves out keeps its last value until its reset passes.
 * - Within one window (resets within the tolerance) usage only rises. A
 *   reading a few points lower is an older one arriving late, and one far
 *   lower reading alone proves nothing.
 * - A run of readings well below the window that hold or rise from one to the
 *   next is the account after a credit nobody's newest read saw: the second
 *   one replaces the window, coarse or not.
 * - A reset well after the known one starts a new window and replaces it. A
 *   reset well before it is a reading from the previous window, and ignored.
 * - A precise reading may refine the reset and labels a coarse reading left;
 *   a coarse one only fills gaps and raises usage.
 * - A reading requested after every precise reading held (see `mark`) is the
 *   newest value and replaces the windows it names, even downward: a Codex
 *   reset credit or a Claude Fable reset lowers usage inside a window. Coarse
 *   readings recorded meanwhile do not overtake it.
 * - A balance (`windowKey: "credits"`) has no window to order by, so the last
 *   reading replaces it.
 * - With `creditsRenewTogether`, a credit that lowers a window also refilled
 *   the windows the provider pairs with it that renew at the same time.
 *   Those the reading leaves out are stale and hidden until a reading names
 *   them.
 *
 * A window past its reset no longer describes the account and is hidden until
 * the provider reports it again; subscribers hear when that happens. An
 * account or plan change clears the limits, because the allowance changed.
 *
 * Held only in memory. A provider that remembers limits across launches
 * (Claude) saves what `snapshot` returns and gives it back to `restore`.
 */

/** Exact resets from one source can still differ by a few seconds. */
const DEFAULT_RESET_TOLERANCE_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** A drop smaller than this, in percent of the limit, is a late reading, not a credit. */
const CREDIT_MIN_DROP_PERCENT = 5;
/** Agreeing readings below the window that show a credit without a newest read. */
const CREDIT_RUN_READINGS = 2;
/** How far a reading may dip below the last one in its run and still agree with it. */
const CREDIT_RUN_DIP_PERCENT = 1;
/** Fields that measure use within a window; the rest describe the window. */
const USAGE_FIELDS = ["usedPercent", "used", "remaining"] as const;

export type PlanLimitReading = {
  limits: readonly BackendRateLimitSummary[];
  /**
   * What `mark` returned when this reading was requested. If no precise
   * reading was recorded since, the reading is the newest and replaces what
   * it names. If
   * the limits were cleared since, it describes the old account and is
   * dropped. Without it, the reading may be older than what is held.
   */
  since?: number;
  /**
   * Exact usage and reset: may refine a reset and labels that a coarse
   * reading left, even when its usage is lower. A coarse reading only fills
   * gaps and raises use.
   */
  precise?: boolean;
  /**
   * How far this reading's reset may sit from the window's true reset. Two
   * resets closer than the larger of the two readings' tolerances are one
   * window. Defaults to five minutes.
   */
  resetToleranceMs?: number;
  /**
   * The reading dates every held limit as read now. Defaults to whether it
   * names every limit held after the merge.
   */
  dated?: boolean;
  /** The opaque account key the reading was taken for, recorded as is. */
  account?: string;
  /**
   * Whether a credit on `credited` also refills `sibling`: Claude's Fable
   * reset gives back what Fable used on the weekly limit. A credited
   * reading's omitted siblings that reset with it are dropped.
   */
  creditsRenewTogether?: (credited: BackendRateLimitSummary, sibling: BackendRateLimitSummary) => boolean;
  /** Relabels a merged row from its fields, after the merge. */
  describe?: (limit: BackendRateLimitSummary) => BackendRateLimitSummary;
};

export type PlanLimitSnapshot = {
  /** Live limits: windows past their reset are left out. */
  limits: BackendRateLimitSummary[];
  account?: string;
  plan?: string;
  /** When the provider last reported these limits, changed or not. */
  observedAt?: number;
};

/**
 * `precise`: the row's reset and labels came from a precise reading.
 * `lower`: the run of readings well below the window seen since it last rose.
 */
type HeldLimit = { limit: BackendRateLimitSummary; toleranceMs: number; precise: boolean; lower?: LowerRun };
/** The last reading in a run of agreeing readings below the window, and how many there were. */
type LowerRun = { usedPercent: number; readings: number };

type Entry = {
  held: HeldLimit[];
  account?: string;
  plan?: string;
  observedAt?: number;
  /** The live limits, valid until the earliest reset among them. */
  live?: { limits: BackendRateLimitSummary[]; until: number };
};

export type PlanLimitStoreOptions = { now?: () => number };

export class PlanLimitStore {
  private readonly entries = new Map<string, Entry>();
  /** Bumped by every precise record and clear; `mark` hands out the current value. */
  private readonly revisions = new Map<string, number>();
  private readonly clearedAt = new Map<string, number>();
  private sequence = 0;
  private readonly listeners = new Set<(provider: string) => void>();
  private expiry?: { at: number; timer: ReturnType<typeof setTimeout> };
  private closed = false;
  private readonly now: () => number;

  constructor(options: PlanLimitStoreOptions = {}) {
    // Read the clock at each call, so a test's fake clock applies.
    this.now = options.now ?? (() => Date.now());
  }

  /** The live limits, or undefined when the provider has reported nothing. */
  limits(provider: string): BackendRateLimitSummary[] | undefined {
    const entry = this.entries.get(provider);
    return entry && this.live(entry);
  }

  snapshot(provider: string): PlanLimitSnapshot | undefined {
    const entry = this.entries.get(provider);
    if (!entry) return undefined;
    return {
      limits: this.live(entry),
      ...(entry.account !== undefined ? { account: entry.account } : {}),
      ...(entry.plan !== undefined ? { plan: entry.plan } : {}),
      ...(entry.observedAt !== undefined ? { observedAt: entry.observedAt } : {}),
    };
  }

  /** A token for a read about to start; pass it back as the reading's `since`. */
  mark(provider: string): number {
    return this.revisions.get(provider) ?? 0;
  }

  /** Merge one reading. Returns whether the live limits changed. */
  record(provider: string, reading: PlanLimitReading): boolean {
    const revision = this.revisions.get(provider) ?? 0;
    if (reading.since !== undefined && reading.since < (this.clearedAt.get(provider) ?? 0)) return false;
    const newest = reading.since !== undefined && reading.since === revision;
    const now = this.now();
    const entry = this.entry(provider);
    const before = this.live(entry);
    const held = mergePlanLimits(entry.held, reading, now, newest);
    const named = new Set(reading.limits.flatMap((limit) =>
      limit.resetAt === undefined || limit.resetAt > now ? [planLimitKey(limit)] : []));
    const dated = reading.dated ?? held.every(({ limit }) => named.has(planLimitKey(limit)));
    entry.held = held;
    if (held.length === 0) entry.observedAt = undefined;
    else if (dated || entry.observedAt === undefined) entry.observedAt = now;
    if ("account" in reading) entry.account = reading.account;
    // Only a precise reading can overtake a read in flight. A coarse one
    // (Claude's stream) arrives from every running CLI, so letting it
    // overtake would keep any probe from ever lowering a window after a
    // reset credit; it could only raise usage anyway.
    if (reading.precise) this.revisions.set(provider, ++this.sequence);
    return this.settle(entry, before);
  }

  /**
   * Record which account and plan the limits describe. A different account,
   * or a different plan on the same account, clears them. A value seen for
   * the first time (none recorded yet) is adopted. A value the provider did
   * not report keeps the one held. Returns whether anything changed.
   */
  setAccount(provider: string, reported: { account?: string; plan?: string }): boolean {
    const entry = this.entry(provider);
    const account = reported.account ?? entry.account;
    const plan = reported.plan ?? entry.plan;
    if (entry.account === account && entry.plan === plan) return false;
    const accountChanged = entry.account !== undefined && entry.account !== account;
    const planChanged = entry.plan !== undefined && entry.plan !== plan;
    entry.account = account;
    entry.plan = plan;
    if (accountChanged || planChanged) this.clear(provider);
    return true;
  }

  /**
   * Forget the limits but keep the provider's entry, so it reads as "reported
   * none". Reads requested before this are dropped. Returns whether the live
   * limits changed.
   */
  clear(provider: string): boolean {
    const known = this.entries.has(provider);
    const entry = this.entry(provider);
    const before = this.live(entry);
    entry.held = [];
    entry.observedAt = undefined;
    this.invalidateReads(provider);
    return this.settle(entry, before) || !known;
  }

  /** Forget the provider entirely, as if it had never reported. */
  forget(provider: string): void {
    this.entries.delete(provider);
    this.invalidateReads(provider);
    this.scheduleExpiry();
  }

  /**
   * Adopt remembered limits, unless the provider has reported since launch:
   * that reading is newer than anything remembered. The remembered account
   * and plan still fill in what has not been reported yet.
   */
  restore(provider: string, saved: PlanLimitSnapshot & { resetToleranceMs?: number }): boolean {
    const known = this.entries.get(provider);
    if (known) {
      known.account ??= saved.account;
      known.plan ??= saved.plan;
      return false;
    }
    const entry = this.entry(provider);
    // Nothing says how precise a remembered reset was, so a probe may refine it.
    entry.held = mergePlanLimits([], { limits: saved.limits, resetToleranceMs: saved.resetToleranceMs }, this.now(), false);
    entry.account = saved.account;
    entry.plan = saved.plan;
    entry.observedAt = entry.held.length > 0 ? saved.observedAt : undefined;
    this.scheduleExpiry();
    return true;
  }

  /** Hear when a provider's window passes its reset and leaves the live limits. */
  subscribe(listener: (provider: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.closed = true;
    if (this.expiry) clearTimeout(this.expiry.timer);
    this.expiry = undefined;
    this.listeners.clear();
  }

  private entry(provider: string): Entry {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = { held: [] };
      this.entries.set(provider, entry);
    }
    return entry;
  }

  private invalidateReads(provider: string): void {
    const revision = ++this.sequence;
    this.revisions.set(provider, revision);
    this.clearedAt.set(provider, revision);
  }

  /** Drop the cached live view; report whether the new one differs from `before`. */
  private settle(entry: Entry, before: BackendRateLimitSummary[]): boolean {
    entry.live = undefined;
    const after = this.live(entry);
    this.scheduleExpiry();
    if (JSON.stringify(before) !== JSON.stringify(after)) return true;
    // Unchanged: keep the earlier array, so readers can compare by reference.
    entry.live = { limits: before, until: entry.live!.until };
    return false;
  }

  private live(entry: Entry): BackendRateLimitSummary[] {
    const now = this.now();
    if (entry.live && entry.live.until > now) return entry.live.limits;
    let until = Number.POSITIVE_INFINITY;
    const limits = entry.held.flatMap(({ limit }) => {
      if (limit.resetAt === undefined) return [limit];
      if (limit.resetAt <= now) return [];
      until = Math.min(until, limit.resetAt);
      return [limit];
    });
    entry.live = { limits, until };
    return limits;
  }

  private scheduleExpiry(): void {
    if (this.closed) return;
    const now = this.now();
    let next: number | undefined;
    for (const entry of this.entries.values()) {
      this.live(entry);
      const reset = entry.live!.until;
      if (Number.isFinite(reset) && (next === undefined || reset < next)) next = reset;
    }
    if (this.expiry?.at === next) return;
    if (this.expiry) clearTimeout(this.expiry.timer);
    this.expiry = undefined;
    if (next === undefined) return;
    const timer = setTimeout(() => {
      this.expiry = undefined;
      this.expire();
    }, Math.min(next - now + 1, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    this.expiry = { at: next, timer };
  }

  /** Drop windows past their reset and tell subscribers whose limits changed. */
  private expire(): void {
    const now = this.now();
    const expired: string[] = [];
    for (const [provider, entry] of this.entries) {
      const held = entry.held.filter(({ limit }) => limit.resetAt === undefined || limit.resetAt > now);
      if (held.length === entry.held.length) continue;
      entry.held = held;
      entry.live = undefined;
      expired.push(provider);
    }
    this.scheduleExpiry();
    for (const provider of expired) {
      for (const listener of [...this.listeners]) listener(provider);
    }
  }
}

/**
 * Which window a row describes: its limit and window slot, or its name for a
 * provider that names neither.
 */
export function planLimitKey(limit: BackendRateLimitSummary): string {
  return limit.limitId !== undefined
    ? `${limit.limitId}\u0000${limit.windowKey ?? ""}`
    : `\u0000${limit.windowKey ?? limit.name}`;
}

/**
 * Merge one reading into the held windows. `newest` means the reading was
 * taken after everything held, so its order leads, followed by the windows it
 * left out; otherwise the held order stays and new windows follow it.
 */
function mergePlanLimits(
  held: readonly HeldLimit[],
  reading: Pick<PlanLimitReading, "limits" | "precise" | "resetToleranceMs" | "creditsRenewTogether" | "describe">,
  now: number,
  newest: boolean,
): HeldLimit[] {
  const toleranceMs = reading.resetToleranceMs ?? DEFAULT_RESET_TOLERANCE_MS;
  const precise = newest || reading.precise === true;
  // A window past its reset no longer describes the account.
  const limits = new Map<string, HeldLimit>();
  for (const known of held) {
    if (known.limit.resetAt === undefined || known.limit.resetAt > now) {
      limits.set(planLimitKey(known.limit), known);
    }
  }
  const named = new Set<string>();
  const credited: HeldLimit[] = [];
  for (const raw of reading.limits) {
    const limit = definedFields(raw);
    if (limit.resetAt !== undefined && limit.resetAt <= now) continue;
    const key = planLimitKey(limit);
    // Aliases of one window in one reading are still one reading of it.
    const counts = !named.has(key);
    named.add(key);
    const known = limits.get(key);
    const merged = mergeWindow(known, { limit, toleranceMs, precise }, newest, counts);
    if (!merged) continue;
    if (known && credit(known, merged)) credited.push(known);
    limits.set(key, reading.describe
      ? { ...merged, limit: reading.describe(merged.limit) }
      : merged);
  }
  const pairs = reading.creditsRenewTogether;
  if (pairs) {
    for (const [key, sibling] of limits) {
      if (named.has(key)) continue;
      if (credited.some((window) => pairs(window.limit, sibling.limit) && renewTogether(window, sibling))) {
        limits.delete(key);
      }
    }
  }
  if (!newest) return [...limits.values()];
  const ordered = new Map<string, HeldLimit>();
  for (const limit of reading.limits) {
    const key = planLimitKey(limit);
    const merged = limits.get(key);
    if (merged) ordered.set(key, merged);
  }
  for (const [key, merged] of limits) {
    if (!ordered.has(key)) ordered.set(key, merged);
  }
  return [...ordered.values()];
}

function mergeWindow(
  known: HeldLimit | undefined,
  reading: HeldLimit,
  newest: boolean,
  counts = true,
): HeldLimit | undefined {
  const { limit } = reading;
  // A balance has no window to order by; the last reading is the balance.
  if (!known || limit.windowKey === "credits") return reading;
  const order = windowOrder(known.limit.resetAt, limit.resetAt, Math.max(known.toleranceMs, reading.toleranceMs));
  // A new window: nothing measured in the old one carries over.
  if (order > 0) return { ...reading, limit: { ...withoutUsage(known.limit), ...limit } };
  // Even the newest read cannot bring back an earlier window: a coarse reading
  // recorded while it was in flight may have started the next one.
  if (order < 0) return undefined;
  if (newest) return refined(known, reading, { ...known.limit, ...limit });
  const lower = lowerRun(known, limit, counts);
  if (compareUsage(known.limit, limit) > 0 || (lower && lower.readings >= CREDIT_RUN_READINGS)) {
    // The reading is the newer one: a precise reading takes over the window,
    // a coarse one only moves its use. A run of agreeing readings far below
    // the window is newer too: the account after a credit.
    return reading.precise
      ? refined(known, reading, { ...known.limit, ...limit })
      : { limit: { ...known.limit, ...usageOf(limit) }, toleranceMs: known.toleranceMs, precise: known.precise };
  }
  // An older reading may still refine a reset that a coarse one left; never
  // one a precise reading set.
  const older = reading.precise && !known.precise
    ? refined(known, reading, { ...known.limit, ...withoutUsage(limit) })
    : known;
  const run = lower ?? known.lower;
  return run ? { ...older, lower: run } : older;
}

/**
 * The window's run of lower readings with this one added, or undefined when
 * the reading is not well below the window. A reading that dips further
 * than the run allows starts a new run. `counts` is false for a second row
 * of the same window in one reading, which moves the run but does not lengthen it.
 */
function lowerRun(known: HeldLimit, limit: BackendRateLimitSummary, counts: boolean): LowerRun | undefined {
  const held = known.limit.usedPercent;
  const used = limit.usedPercent;
  if (held === undefined || used === undefined || used > held - CREDIT_MIN_DROP_PERCENT) return undefined;
  const run = known.lower;
  return run && used >= run.usedPercent - CREDIT_RUN_DIP_PERCENT
    ? { usedPercent: used, readings: run.readings + (counts ? 1 : 0) }
    : { usedPercent: used, readings: 1 };
}

/**
 * Whether the merge credited the window: lowered its use well within the
 * same window. A window that starts early is not one, since nothing yet shows
 * what that does to the windows that renew with it.
 */
function credit(known: HeldLimit, merged: HeldLimit): boolean {
  const before = known.limit.usedPercent;
  const after = merged.limit.usedPercent;
  return before !== undefined && after !== undefined && after <= before - CREDIT_MIN_DROP_PERCENT
    && windowOrder(known.limit.resetAt, merged.limit.resetAt, Math.max(known.toleranceMs, merged.toleranceMs)) === 0;
}

/** Two windows renew together when they are as long and reset within the larger tolerance. */
function renewTogether(window: HeldLimit, sibling: HeldLimit): boolean {
  const { resetAt, windowMinutes } = window.limit;
  return resetAt !== undefined && sibling.limit.resetAt !== undefined
    && windowMinutes === sibling.limit.windowMinutes
    && windowOrder(resetAt, sibling.limit.resetAt, Math.max(window.toleranceMs, sibling.toleranceMs)) === 0;
}

/** A merged row whose reset and labels now come from `reading` where it named them. */
function refined(known: HeldLimit, reading: HeldLimit, limit: BackendRateLimitSummary): HeldLimit {
  return {
    limit,
    toleranceMs: reading.limit.resetAt !== undefined ? reading.toleranceMs : known.toleranceMs,
    precise: known.precise || reading.precise,
  };
}

/** -1: the reading is from an earlier window; 0: the same window; 1: a later one. */
function windowOrder(known: number | undefined, reading: number | undefined, toleranceMs: number): -1 | 0 | 1 {
  // A reading without a reset is taken to describe the known window. A
  // window without one cannot be ordered, so a reading that names its reset
  // replaces it.
  if (reading === undefined) return 0;
  if (known === undefined) return 1;
  if (reading > known + toleranceMs) return 1;
  if (reading < known - toleranceMs) return -1;
  return 0;
}

/**
 * Within one window, the reading that measured more use is the newer one.
 * 1: the reading is newer; 0: the same or unknown; -1: older.
 */
function compareUsage(known: BackendRateLimitSummary, reading: BackendRateLimitSummary): -1 | 0 | 1 {
  for (const field of ["usedPercent", "used"] as const) {
    const before = known[field];
    const after = reading[field];
    if (after === undefined) continue;
    // Nothing measured yet: any measurement fills the gap.
    if (before === undefined) return 1;
    return after > before ? 1 : after < before ? -1 : 0;
  }
  return 0;
}

function usageOf(limit: BackendRateLimitSummary): Partial<BackendRateLimitSummary> {
  const usage: Partial<BackendRateLimitSummary> = {};
  for (const field of USAGE_FIELDS) {
    if (limit[field] !== undefined) usage[field] = limit[field];
  }
  return usage;
}

function withoutUsage(limit: BackendRateLimitSummary): BackendRateLimitSummary {
  const { usedPercent: _usedPercent, used: _used, remaining: _remaining, ...rest } = limit;
  return rest;
}

/** A field a reading leaves undefined is not a reading of that field. */
function definedFields(limit: BackendRateLimitSummary): BackendRateLimitSummary {
  let defined: BackendRateLimitSummary | undefined;
  for (const [field, value] of Object.entries(limit)) {
    if (value !== undefined) continue;
    defined ??= { ...limit };
    delete (defined as Record<string, unknown>)[field];
  }
  return defined ?? limit;
}
