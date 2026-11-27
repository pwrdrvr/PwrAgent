import { OrderedPricingRows } from "./ordered-pricing-rows";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import {
  addTokenMiserGateAccountingTotals, emptyTokenMiserGateAccountingTotals, totalTokenMiserGateAccountings,
} from "@pwragent/shared/token-miser-savings-summary";
import type { PricingHistoryPage } from "@pwragent/shared/thread-pricing-display";
import type { ThreadToolInvocationRecord } from "@pwragent/shared/contracts/normalized-app-server";
import type { TokenMiserGateAccountingTotals } from "@pwragent/shared/token-miser-savings-summary";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import type { ThreadPricingPageIndex } from "./thread-pricing-page";

interface WatchedRows<T> extends ReadonlyMap<string, T> {
  watchChanges(listener: (id?: string) => void): () => void;
}

export type PricingAccountingReader = {
  gate(source: string): ThreadUsageLineRecord | undefined;
  parent(turn: string): ThreadUsageLineRecord | undefined;
  focusedCost(): number | undefined;
  invocations(): ThreadToolInvocationRecord[];
};

export interface PricingPageAccounting {
  close(): void;
  reset(): void;
  changed(line: ThreadUsageLineRecord): void;
  project(page: PricingHistoryPage, totals: TokenMiserGateAccountingTotals, reader: PricingAccountingReader, defer?: boolean): void;
}

export interface PricingPageOverlay {
  lines?: WatchedRows<ThreadUsageLineRecord>;
  cards?: WatchedRows<ThreadSubAgentSummary>;
  accountingOwner?: object;
  liveGate?(id: string): ThreadUsageLineRecord | undefined;
  openAccounting?(): PricingPageAccounting | undefined;
  accountingFailed?(error: unknown): void;
  decorationKey: string;
  decorate(line: ThreadUsageLineRecord): ThreadUsageLineRecord;
  isLocal(line: ThreadUsageLineRecord): boolean;
}

/** Subscribe while a thread is open. Retiring a collection reveals the
 * persisted versions of just the ids it used to replace. */
export class PricingPageLiveRows<T> {
  private source?: WatchedRows<T>;
  private readonly keys = new Set<string>();
  private unsubscribe?: () => void;

  sync(next: WatchedRows<T> | undefined, dirty: Set<string>): void {
    if (this.source === next) return;
    this.unsubscribe?.();
    for (const id of this.keys) dirty.add(id);
    this.keys.clear();
    this.source = next;
    for (const id of next?.keys() ?? []) {
      dirty.add(id);
      this.keys.add(id);
    }
    this.unsubscribe = next?.watchChanges((id) => {
      if (id === undefined) {
        for (const key of this.keys) dirty.add(key);
        this.keys.clear();
      } else {
        dirty.add(id);
        if (next.has(id)) this.keys.add(id);
        else this.keys.delete(id);
      }
    });
  }

  close(): void { this.unsubscribe?.(); }
}

export class PricingPageCards {
  private readonly known = new Set<string>();
  readonly effective = new Map<string, ThreadSubAgentSummary>();
  private readonly substitutions = new Map<string, ReturnType<typeof emptyTokenMiserGateAccountingTotals>>();
  adjustment = emptyTokenMiserGateAccountingTotals();
  private readonly checksum = Buffer.alloc(32);

  needs(id: string): boolean { return !this.known.has(id); }

  update(ids: Set<string>, read: (ids: string[]) => ThreadSubAgentSummary[], live?: PricingPageOverlay["cards"], index?: ThreadPricingPageIndex): boolean {
    if (!ids.size) return true;
    const stored = new Map(read([...ids]).map((card) => [card.monitorId, card]));
    let valid = true;
    for (const id of ids) {
      const persisted = stored.get(id);
      this.known.add(id);
      const replacement = live?.get(id);
      const previous = this.substitutions.get(id);
      if (previous) {
        this.adjustment = addTokenMiserGateAccountingTotals(this.adjustment, previous, -1);
        this.substitutions.delete(id);
      }
      if (replacement && id.startsWith("system:token-miser:")) {
        const delta = addTokenMiserGateAccountingTotals(totalTokenMiserGateAccountings([replacement.tokenMiserAccounting]),
          totalTokenMiserGateAccountings(persisted ? [persisted.tokenMiserAccounting] : []), -1);
        this.adjustment = addTokenMiserGateAccountingTotals(this.adjustment, delta);
        this.substitutions.set(id, delta);
      }
      const next = replacement ?? persisted;
      const old = this.effective.get(id);
      if (isDeepStrictEqual(old, next)) continue;
      if (old) this.toggle(old);
      if (next) this.toggle(next);
      if (index && !index.setCard(id, next)) valid = false;
      if (next) this.effective.set(id, next);
      else this.effective.delete(id);
    }
    return valid;
  }

  // A cold page loads cards referenced by a monitor row or the live overlay.
  // Retiring either last reference must leave the same cursor checksum.
  forgetUnused(ids: Set<string>, index: ThreadPricingPageIndex, live?: PricingPageOverlay["cards"]): void {
    for (const id of ids) {
      if (index.hasMonitor(id) || live?.has(id)) continue;
      const previous = this.effective.get(id);
      if (previous) this.toggle(previous);
      this.effective.delete(id);
      this.known.delete(id);
    }
  }

  private toggle(card: ThreadSubAgentSummary): void {
    const digest = createHash("sha256").update(JSON.stringify(card)).digest();
    for (let i = 0; i < digest.length; i++) this.checksum[i] = this.checksum[i]! ^ digest[i]!;
  }

  revision(): string { return this.checksum.toString("base64url"); }
}

/** Savings uses the first stored helper/parent in ledger order, even when the
 * displayed charge is replaced by a live row with the same usage id. */
export class PricingPagePrices {
  private readonly lines = new Map<string, ThreadUsageLineRecord>();
  private readonly parents = new Map<string, OrderedPricingRows>();
  private readonly gates = new Map<string, OrderedPricingRows>();
  private cost = 0;
  private unpriced = 0;

  constructor(private readonly threadId: string) {}

  replace(id: string, line: ThreadUsageLineRecord | undefined, accounting: PricingPageAccounting): void {
    const previous = this.lines.get(id);
    if (!previous && !line) return;
    if (previous && line) {
      // A turn's token count or completion time cannot change its gates' parent
      // rate. A monitor's price and position in the stored lookup can.
      const keys = ["sourceItemId", "threadId", "scope", "turnId", "usageTurnId", "createdAt", "model", "serviceTier", "fastMode"] as const;
      if (keys.every((key) => previous[key] === line[key]) && (line.scope !== "monitor" && !line.sourceItemId?.startsWith("system:token-miser")
        || (line.priceStatus === previous.priceStatus && line.totalCostMicros === previous.totalCostMicros && line.currency === previous.currency))) return;
    }
    if (previous) this.update(previous, false, accounting);
    if (line) this.update(line, true, accounting);
  }

  private update(line: ThreadUsageLineRecord, add: boolean, accounting: PricingPageAccounting): void {
    if (add) this.lines.set(line.usageLineId, line);
    else this.lines.delete(line.usageLineId);
    const bucket = (map: Map<string, OrderedPricingRows>, key: string) => {
      const rows = map.get(key) ?? new OrderedPricingRows((a, b) => a.createdAt - b.createdAt
        || Buffer.compare(Buffer.from(a.usageLineId), Buffer.from(b.usageLineId)));
      rows.update(line, add);
      if (rows.size) map.set(key, rows);
      else map.delete(key);
    };
    if (line.sourceItemId?.startsWith("system:token-miser:")) bucket(this.gates, line.sourceItemId);
    if (line.scope !== "monitor" && line.model && line.threadId === this.threadId) {
      for (const turn of new Set([line.turnId, line.usageTurnId])) if (turn) bucket(this.parents, turn);
    }
    if (line.sourceItemId?.startsWith("system:token-miser-focused:")) {
      if (line.priceStatus === "priced") this.cost += (add ? 1 : -1) * line.totalCostMicros;
      else this.unpriced += add ? 1 : -1;
    }
    accounting.changed(line);
  }

  gate = (source: string) => this.gates.get(source)?.newest();
  parent = (turn: string) => this.parents.get(turn)?.newest();
  focusedCost = () => this.unpriced ? undefined : this.cost;
}
