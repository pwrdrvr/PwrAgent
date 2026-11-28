import { createHash } from "node:crypto";
import { buildTokenMiserSavingsSummary, emptyTokenMiserGateAccountingTotals, totalTokenMiserGateAccountings, addTokenMiserGateAccountingTotals,
  type TokenMiserGateAccountingTotals } from "@pwragent/shared/token-miser-savings-summary";
import type { PricingDecision, PricingHistoryPage } from "@pwragent/shared/thread-pricing-display";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import { estimateTokenCount } from "../token-miser/token-miser-types";
import { indexTokenMiserCachedReplays } from "./token-miser-ledger-index";
import { buildTaskMonitorUsageTotals, priceBoundedCommandDelivery, resolveTokenMiserGateAccounting } from "./thread-usage-math";
import type { PricingAccountingReader } from "../state/overlay-store-sqlite";

type MetadataChanges = NonNullable<ReturnType<TokenMiserStore["watchPricingMetadata"]>>;
type MetadataRow = NonNullable<ReturnType<MetadataChanges["get"]>>;
type AccountingRow = MetadataRow & {
  terms: TokenMiserGateAccountingTotals;
  decision?: PricingDecision;
  digest: Buffer;
};

type Decisions = {
  rows: Map<string, AccountingRow>;
  helperDecisionCount: number; policyDecisionCount: number;
  helperPassThroughCount: number; policyPassThroughCount: number;
};

/** Pricing needs the three dollar terms, decision counts and (only on
 * expansion) two decision fields. The Explorer still owns the full report. */
export class TokenMiserPricingPage {
  private readonly rows = new Map<string, AccountingRow>();
  private readonly turns = new Map<string, Decisions>();
  private readonly dirty = new Set<string>();
  private readonly metadataChanges: Set<string>;
  private readonly checksum = Buffer.alloc(32);
  private readonly metadata: MetadataChanges;
  private version?: number;
  private totals = emptyTokenMiserGateAccountingTotals();
  private helpers = 0;
  private passed = 0;
  private avoided = 0;
  private legacyCount = 0;
  private legacyTurns = new Map<string, string>();

  static open(store: TokenMiserStore, threadId: string, backend: AppServerBackendKind) {
    const changes = new Set<string>();
    const metadata = store.watchPricingMetadata?.(threadId, (id) => changes.add(id));
    return metadata && new TokenMiserPricingPage(metadata, changes, backend);
  }

  private constructor(metadata: MetadataChanges, changes: Set<string>, private readonly backend: AppServerBackendKind) {
    this.metadata = metadata;
    this.metadataChanges = changes;
  }

  close(): void { this.metadata.close(); }
  reset(): void { this.version = undefined; }

  changed(line: ThreadUsageLineRecord): void {
    if (line.sourceItemId?.startsWith("system:token-miser:")) this.dirty.add(line.sourceItemId.slice("system:token-miser:".length));
    if (line.scope !== "monitor" && line.model) {
      for (const turn of [line.turnId, line.usageTurnId]) {
        if (turn) for (const id of this.turns.get(turn)?.rows.keys() ?? []) this.dirty.add(id);
      }
    }
  }

  private update(row: AccountingRow, add: boolean): void {
    const sign = add ? 1 : -1;
    const { entry, decision } = row;
    const group = this.turns.get(entry.turnId) ?? {
      rows: new Map<string, AccountingRow>(), helperDecisionCount: 0, policyDecisionCount: 0, helperPassThroughCount: 0, policyPassThroughCount: 0,
    };
    if (add) {
      this.rows.set(entry.objectId, row);
      group.rows.set(entry.objectId, row);
    } else {
      this.rows.delete(entry.objectId);
      group.rows.delete(entry.objectId);
    }
    if (group.rows.size) this.turns.set(entry.turnId, group);
    else this.turns.delete(entry.turnId);
    if (decision?.decisionSource === "policy") group.policyDecisionCount += sign;
    else if (decision) group.helperDecisionCount += sign;
    if (decision?.disposition === "passed_through") {
      if (decision.decisionSource === "policy") group.policyPassThroughCount += sign;
      else group.helperPassThroughCount += sign;
      this.passed += sign;
    }
    if (entry.helperUsage) this.helpers += sign;
    if (decision && entry.replayTrackingVersion !== 2) this.legacyCount += sign;
    this.avoided += sign * (entry.baselineParentTokens - estimateTokenCount(entry.replacementCharacters) - estimateTokenCount(entry.retrievedCharacters));
    this.totals = addTokenMiserGateAccountingTotals(this.totals, row.terms, sign);
    for (let i = 0; i < row.digest.length; i++) this.checksum[i] = this.checksum[i]! ^ row.digest[i]!;
  }

  project(page: PricingHistoryPage, gateTotals: TokenMiserGateAccountingTotals, reader: PricingAccountingReader, defer?: boolean): void {
    const version = this.metadata.dataVersion();
    const changed = new Map<string, MetadataRow | undefined>();
    if (this.version !== version) {
      for (const row of this.rows.values()) this.update(row, false);
      for (const row of this.metadata.all()) changed.set(row.entry.objectId, row);
      this.version = version;
    } else {
      for (const id of this.metadataChanges) changed.set(id, this.metadata.get(id));
    }
    this.metadataChanges.clear();
    const legacy = this.backend === "codex"
      && (this.legacyCount || [...changed.values()].some((row) => row && !row.entry.captureBackend && row.entry.replayTrackingVersion !== 2));
    const invocations = legacy ? reader.invocations() : [];
    if (legacy) {
      const byTurn = new Map<string, string[]>();
      for (const row of invocations) {
        if (!row.turnId) continue;
        const items = byTurn.get(row.turnId) ?? [];
        items.push(JSON.stringify([row.itemId, row.invocationId, row.observedAt]));
        byTurn.set(row.turnId, items);
      }
      const next = new Map([...byTurn].map(([turn, rows]) => [turn, JSON.stringify(rows)]));
      for (const turn of new Set([...next.keys(), ...this.legacyTurns.keys()])) {
        if (next.get(turn) === this.legacyTurns.get(turn)) continue;
        for (const [id, row] of this.turns.get(turn)?.rows ?? []) {
          if (row.decision && row.entry.replayTrackingVersion !== 2) this.dirty.add(id);
        }
      }
      this.legacyTurns = next;
    }
    for (const id of this.dirty) if (!changed.has(id)) changed.set(id, this.rows.get(id));
    this.dirty.clear();
    const indexes = { pricing: {
      gateUsageLine: (id: string) => reader.gate(id), parentUsageLine: (_thread: string, turn: string) => reader.parent(turn),
      appendGateUsageLine: () => {},
    }, replays: indexTokenMiserCachedReplays(invocations) };
    for (const [id, row] of changed) {
      const previous = this.rows.get(id);
      if (previous) this.update(previous, false);
      if (!row || (row.entry.captureBackend ?? "codex") !== this.backend) continue;
      const { entry } = row;
      if (entry.captureBackend) {
        const cost = priceBoundedCommandDelivery(entry, reader.parent(entry.turnId));
        const terms = emptyTokenMiserGateAccountingTotals();
        if (cost) {
          terms.terms.withoutGateCostMicros = cost.baseline;
          terms.terms.revealedCostMicros = cost.delivered;
          terms.terms.savingsMicros = cost.baseline - cost.delivered;
        }
        const digest = createHash("sha256").update(JSON.stringify([id, row.createdAt, cost])).digest();
        this.update({ ...row, terms, digest }, true);
        continue;
      }
      const { tokenMiserAccounting } = resolveTokenMiserGateAccounting({
        entry, indexes, helperUsage: () => entry.helperUsage?.tokenUsage ? buildTaskMonitorUsageTotals({
          model: entry.helperUsage.model, serviceTier: entry.helperUsage.serviceTier, tokenUsage: entry.helperUsage.tokenUsage,
        }) : undefined,
      });
      const decision = { decisionSource: entry.helperUsage ? "helper" as const
        : entry.disposition === "passed_through" ? "policy" as const : undefined, disposition: entry.disposition };
      const terms = totalTokenMiserGateAccountings([tokenMiserAccounting]);
      const digest = createHash("sha256").update(JSON.stringify([id, entry.turnId, decision, row.createdAt, row.rowid, terms])).digest();
      this.update({ ...row, decision, terms, digest }, true);
    }

    const callCount = this.backend === "codex" ? this.metadata.observationCount() : 0;
    const count = this.rows.size;
    const accounting = {
      interceptionCount: count, helperDecisionCount: this.helpers, passThroughCount: this.passed, estimatedParentTokensSaved: this.avoided,
      codeMode: { callCount },
    };
    const helperCost = reader.auxiliaryHelperCost();
    const terms = this.totals.terms;
    const savings = this.totals.pricedCount && helperCost !== undefined ? {
      ...terms, gateCostMicros: terms.gateCostMicros + helperCost, savingsMicros: terms.savingsMicros - helperCost,
      pricedGateCount: this.totals.pricedCount,
    } : undefined;
    page.savings = { summary: buildTokenMiserSavingsSummary({
      accounting: { ...accounting, savings },
      gateTotals: savings ? gateTotals : { ...gateTotals, pricedCount: 0 },
    }) };
    for (const group of page.groups?.values() ?? []) {
      const decisions = group.parentTurnId && this.turns.get(group.parentTurnId);
      if (!decisions) continue;
      const { rows, ...counts } = decisions;
      const count = counts.helperDecisionCount + counts.policyDecisionCount;
      if (!count) continue;
      group.summary = { ...group.summary, ...counts, hasDecisions: true, count };
      if (!defer) group.decisions = [...rows.values()].sort((a, b) => b.createdAt - a.createdAt || b.rowid - a.rowid)
        .flatMap((row) => row.decision ?? []);
    }
    page.revision += this.checksum.toString("base64url") + JSON.stringify(page.savings);
  }
}
