import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  navigationAttentionIdentity,
  observeNavigationAttentionTurn,
  reconcileNavigationAttentionOrder,
  removeNavigationAttentionMember,
} from "../navigation-attention-order";

const ids = ["a", "b", "c", "d"];
type Phase = "idle" | "live" | "finished";
type Snapshot = { observedAt: number; rows: NavigationThreadSummary[]; phases: Phase[] };

function thread(id: string, active: boolean, updatedAt: number): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "derived", linkedDirectories: [],
    inbox: { inInbox: true }, threadStatus: active ? "active" : "idle", updatedAt };
}

const operation = fc.record({ index: fc.nat(3), kind: fc.constantFrom("start", "activity", "finish") });

// Generate provider-ordered histories first. Only delivery is shuffled; a
// completed turn always has a real start, even if no read sees it live.
const deliveries = fc.array(operation, { minLength: 1, maxLength: 30 }).chain((operations) => {
  let rows = ids.map((id, index) => thread(id, false, ids.length - index));
  const phases: Phase[] = ids.map(() => "idle");
  const snapshots: Snapshot[] = [{ observedAt: 1, rows, phases: [...phases] }];
  for (const [index, op] of operations.entries()) {
    const phase = phases[op.index];
    if (op.kind === "start" && phase === "idle") phases[op.index] = "live";
    else if (op.kind === "finish" && phase === "live") phases[op.index] = "finished";
    else if (op.kind !== "activity" || phase !== "live") continue;
    rows = rows.map((row, rowIndex) => rowIndex === op.index
      ? thread(row.id, phases[rowIndex] === "live", index + 10) : row);
    snapshots.push({ observedAt: index + 2, rows, phases: [...phases] });
  }
  return fc.tuple(
    fc.shuffledSubarray(snapshots, { minLength: snapshots.length, maxLength: snapshots.length }),
    fc.array(fc.nat(), { maxLength: 20 }),
  ).map(([shuffled, replays]) => ({ initial: snapshots[0]!,
    snapshots: [...shuffled, ...replays.map((index) => snapshots[index % snapshots.length]!)] }));
});

function assertUnique(order: ReturnType<typeof reconcileNavigationAttentionOrder>): void {
  const ranks = [...order.members.values()].map((member) => member.rank);
  expect(new Set(ranks).size).toBe(ranks.length);
  expect(ranks.every((rank) => rank < order.nextRank)).toBe(true);
}

describe("owner Attention order properties (AGENTS.md: Attention order)", () => {
  it.each([true, false])("pre-#3012: a listing begun before a turn started cannot end it, promotion=%s", (promoteOnTurnEnd) => {
    // Named version of the shrunk property failure: idle(1), live(2), idle(1).
    const idle = thread("a", false, 1);
    const key = navigationAttentionIdentity(idle);
    const initial = reconcileNavigationAttentionOrder({ threads: [idle], observedAt: 1, promoteOnTurnEnd });
    const live = reconcileNavigationAttentionOrder({ previous: initial, threads: [thread("a", true, 2)],
      observedAt: 2, promoteOnTurnEnd });
    const stale = reconcileNavigationAttentionOrder({ previous: live, threads: [idle], observedAt: 1, promoteOnTurnEnd });
    expect(stale.members.get(key)).toEqual(live.members.get(key));
    expect(stale.nextRank).toBe(live.nextRank);
  });

  it.each([true, false])("moves at most twice per turn under shuffled, duplicate and stale listings, promotion=%s", (promoteOnTurnEnd) => {
    fc.assert(fc.property(deliveries, ({ initial, snapshots }) => {
      let order = reconcileNavigationAttentionOrder({ threads: initial.rows, observedAt: initial.observedAt, promoteOnTurnEnd });
      let accepted = initial;
      let expected = [...ids];
      const moves = ids.map(() => 0);
      for (const snapshot of snapshots) {
        const before = order;
        const promotions: number[] = [];
        if (snapshot.observedAt > accepted.observedAt) {
          for (const [index, phase] of snapshot.phases.entries()) {
            // An independent phase oracle: live activity cannot move; a
            // skipped live phase earns only the optional completion move.
            if (phase !== accepted.phases[index]
              && (phase === "live" || (phase === "finished" && promoteOnTurnEnd))) promotions.push(index);
          }
          promotions.sort((a, b) => snapshot.rows[a]!.updatedAt! - snapshot.rows[b]!.updatedAt!);
          for (const index of promotions) expected = [ids[index]!, ...expected.filter((id) => id !== ids[index])];
          accepted = snapshot;
        }
        order = reconcileNavigationAttentionOrder({ previous: order, threads: [...snapshot.rows].reverse(),
          observedAt: snapshot.observedAt, promoteOnTurnEnd });
        expect(order.nextRank - before.nextRank).toBe(promotions.length);
        expect([...order.members].sort((a, b) => b[1].rank - a[1].rank).map(([key]) => key))
          .toEqual(expected.map((id) => navigationAttentionIdentity(thread(id, false, 0))));
        expect(order.members.size).toBe(ids.length);
        for (const [index, row] of snapshot.rows.entries()) {
          const key = navigationAttentionIdentity(row);
          if (order.members.get(key)!.rank !== before.members.get(key)!.rank) moves[index]! += 1;
          expect(moves[index]).toBeLessThanOrEqual(promoteOnTurnEnd ? 2 : 1);
          expect(order.members.get(key)!.active).toBe(accepted.phases[index] === "live");
        }
        assertUnique(order);
      }
    }));
  });

  it.each([true, false])("boundary-owned turns ignore late reads and repeated baselines, promotion=%s", (promoteOnTurnEnd) => {
    fc.assert(fc.property(fc.array(fc.record({
      index: fc.nat(3),
      replays: fc.array(fc.nat(), { minLength: 1, maxLength: 8 }),
    }), { minLength: 1, maxLength: 12 }), (turns) => {
      let clock = 1;
      let rows = ids.map((id) => thread(id, false, 1));
      let order = reconcileNavigationAttentionOrder({ threads: rows, observedAt: clock, promoteOnTurnEnd });
      const reads = [{ rows, observedAt: clock }];
      for (const [turnIndex, turn] of turns.entries()) {
        const key = navigationAttentionIdentity(rows[turn.index]!);
        const turnId = `turn-${turnIndex}`;
        const before = order;
        order = observeNavigationAttentionTurn({ previous: order, key, active: true, turnId, observedAt: ++clock, promoteOnTurnEnd });
        expect(order.nextRank).toBe(before.nextRank + 1);
        rows = rows.map((row, index) => index === turn.index ? thread(row.id, true, clock) : row);
        reads.push({ rows, observedAt: ++clock });
        // This read starts live and can land after the completion write.
        order = observeNavigationAttentionTurn({ previous: order, key, active: false, turnId, observedAt: ++clock, promoteOnTurnEnd });
        expect(order.nextRank).toBe(before.nextRank + 1 + Number(promoteOnTurnEnd));
        rows = rows.map((row, index) => index === turn.index ? thread(row.id, false, clock) : row);
        reads.push({ rows, observedAt: ++clock });
        const finishedRanks = new Map([...order.members].map(([key, member]) => [key, member.rank]));
        const finishedNextRank = order.nextRank;
        // First acknowledge the finished state, then deliver reads in arbitrary
        // order, including reads from earlier turns and duplicate completions.
        for (const read of [reads.at(-1)!, ...turn.replays.map((index) => reads[index % reads.length]!)]) {
          order = reconcileNavigationAttentionOrder({ previous: order, threads: read.rows,
            observedAt: read.observedAt, promoteOnTurnEnd });
          expect(new Map([...order.members].map(([key, member]) => [key, member.rank]))).toEqual(finishedRanks);
          expect(order.nextRank).toBe(finishedNextRank);
          expect(order.members.get(key)!.active).toBe(false);
          assertUnique(order);
        }
      }
    }));
  });

  it("a stale listing cannot resurrect a removed member; a fresh return gets a new top rank", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 1_000 }), fc.nat(1_000), (removedAt, delay) => {
      const rows = ids.map((id) => thread(id, false, 1));
      const key = navigationAttentionIdentity(rows[0]!);
      const initial = reconcileNavigationAttentionOrder({ threads: rows, observedAt: 1, promoteOnTurnEnd: true });
      const removed = removeNavigationAttentionMember({ previous: initial, key, observedAt: removedAt });
      const stale = reconcileNavigationAttentionOrder({ previous: removed, threads: rows,
        observedAt: removedAt - 1, promoteOnTurnEnd: true });
      expect(stale.members.has(key)).toBe(false);
      expect(stale.nextRank).toBe(removed.nextRank);
      const returned = reconcileNavigationAttentionOrder({ previous: stale, threads: rows,
        observedAt: removedAt + delay + 1, promoteOnTurnEnd: true });
      expect(returned.members.get(key)!.rank).toBe(removed.nextRank);
      expect(returned.members.size).toBe(ids.length);
      assertUnique(returned);
    }));
  });
});
