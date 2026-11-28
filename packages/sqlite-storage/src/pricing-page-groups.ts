import type { ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import {
  isTokenMiserGateLine, TOKEN_MISER_CARD_MIN_MICROS,
  type PricingGateGroupDisplay, type PricingGateSelection, type PricingUsageLine,
} from "@pwragent/shared/thread-pricing-display";

import { OrderedPricingRows } from "./ordered-pricing-rows";

class GateGroup {
  readonly all = new OrderedPricingRows();
  readonly significant = new OrderedPricingRows();
  readonly small = new OrderedPricingRows();
  private smallSavings = 0;
  private savings = 0;
  private cost = 0;
  private policy = 0;
  private helperPassed = 0;
  private policyPassed = 0;

  update(line: PricingUsageLine, agent: ThreadSubAgentSummary | undefined, add: boolean): void {
    const sign = add ? 1 : -1;
    this.all.update(line, add);
    const accounting = agent?.tokenMiserAccounting;
    if (accounting) {
      const significant = Math.abs(accounting.savingsMicros) >= TOKEN_MISER_CARD_MIN_MICROS;
      (significant ? this.significant : this.small).update(line, add);
      if (!significant) this.smallSavings += sign * accounting.savingsMicros;
      this.savings += sign * accounting.savingsMicros;
      const policy = accounting.decisionSource === "policy";
      if (policy) this.policy += sign;
      if (accounting.disposition === "passed_through") {
        if (policy) this.policyPassed += sign;
        else this.helperPassed += sign;
      }
    }
    this.cost += sign * line.totalCostMicros;
  }

  summary(): PricingGateGroupDisplay {
    const count = this.all.size;
    const primary = this.significant.size;
    return {
      gateCount: count, primaryCount: primary || this.small.size, smallCount: primary ? this.small.size : 0,
      unpricedCount: count - primary - this.small.size, smallMicros: primary ? this.smallSavings : 0,
      savingsMicros: this.savings, gateCostMicros: this.cost, hasDecisions: false, count,
      helperDecisionCount: count - this.policy, policyDecisionCount: this.policy,
      helperPassThroughCount: this.helperPassed, policyPassThroughCount: this.policyPassed,
    };
  }
}

/** Page in display order, after collapsing gates (including visible orphan anchors). */
export class PricingPageGroups {
  private readonly top = new OrderedPricingRows();
  private readonly turns = new Map<string, number>();
  private readonly groups = new Map<string, GateGroup>();
  private readonly anchors = new Map<string, GateGroup>();
  private readonly lines = new Map<string, PricingUsageLine>();
  private readonly byMonitor = new Map<string, Set<PricingUsageLine>>();

  constructor(readonly cards: Map<string, ThreadSubAgentSummary>) {}

  private anchor(key: string, group: GateGroup): PricingUsageLine | undefined {
    if (this.turns.has(key) || !(group.significant.size || group.small.size)) return undefined;
    return group.all.newest();
  }

  private setAnchor(key: string, group: GateGroup, add: boolean): void {
    const line = this.anchor(key, group);
    if (!line) return;
    this.top.update(line, add);
    if (add) this.anchors.set(line.usageLineId, group);
    else this.anchors.delete(line.usageLineId);
  }

  private gate(line: PricingUsageLine, add: boolean): void {
    const card = this.cards.get(line.sourceItemId!);
    const key = card?.parentTurnId ?? `gate:${line.usageLineId}`;
    const group = this.groups.get(key) ?? new GateGroup();
    this.setAnchor(key, group, false);
    group.update(line, card, add);
    if (group.all.size) this.groups.set(key, group);
    else this.groups.delete(key);
    this.setAnchor(key, group, true);
  }

  hasMonitor(id: string): boolean { return this.byMonitor.has(id); }

  setCard(id: string, card?: ThreadSubAgentSummary): boolean {
    const previous = this.cards.get(id);
    const oldModel = previous?.preferredModel ?? previous?.monitorUsage?.model ?? previous?.monitorUsage?.cost?.model;
    const newModel = card?.preferredModel ?? card?.monitorUsage?.model ?? card?.monitorUsage?.cost?.model;
    const affected = this.byMonitor.get(id);
    for (const line of affected ?? []) if (isTokenMiserGateLine(line)) this.gate(line, false);
    if (card) this.cards.set(id, card);
    else this.cards.delete(id);
    for (const line of affected ?? []) if (isTokenMiserGateLine(line)) this.gate(line, true);
    return oldModel === newModel || !Array.from(affected ?? []).some((line) => !line.model);
  }

  update(line: PricingUsageLine, add: boolean): void {
    if (add) this.lines.set(line.usageLineId, line);
    else this.lines.delete(line.usageLineId);
    if (line.scope === "monitor" && line.sourceItemId) {
      const rows = this.byMonitor.get(line.sourceItemId) ?? new Set();
      if (add) rows.add(line);
      else rows.delete(line);
      if (rows.size) this.byMonitor.set(line.sourceItemId, rows);
      else this.byMonitor.delete(line.sourceItemId);
    }
    if (isTokenMiserGateLine(line)) return this.gate(line, add);
    if (line.scope !== "monitor" && line.turnId) {
      const key = line.turnId;
      const group = this.groups.get(key);
      if (group) this.setAnchor(key, group, false);
      const count = (this.turns.get(key) ?? 0) + (add ? 1 : -1);
      if (count) this.turns.set(key, count);
      else this.turns.delete(key);
      if (group) this.setAnchor(key, group, true);
    }
    this.top.update(line, add);
  }

  group(line: PricingUsageLine) {
    return this.anchors.get(line.usageLineId) ?? (line.scope !== "monitor" && line.turnId ? this.groups.get(line.turnId) : undefined);
  }

  isOrphan(line: PricingUsageLine): boolean { return this.anchors.has(line.usageLineId); }

  page(offset: number, limit: number, selection?: PricingGateSelection) {
    let rows = this.top;
    if (selection) {
      const line = this.lines.get(selection.usageLineId);
      const group = line && this.group(line);
      if (!group || (selection.filter === "small" && !group.significant.size)) return { lines: [], totalRows: 0 };
      rows = selection.filter === "primary" && group.significant.size ? group.significant : group.small;
    }
    return { lines: rows.page(offset, limit), totalRows: rows.size };
  }
}
