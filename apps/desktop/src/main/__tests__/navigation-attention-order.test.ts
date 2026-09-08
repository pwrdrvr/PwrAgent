import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { navigationAttentionIdentity, observeNavigationAttentionTurn, reconcileNavigationAttentionOrder } from "../app-server/navigation-attention-order";

const thread = (id: string, updatedAt: number): NavigationThreadSummary => ({ id, source: "codex", title: id, titleSource: "fallback",
  linkedDirectories: [], updatedAt, threadStatus: "active", inbox: { inInbox: true } });

it("does not promote an old completed turn after a newer completed turn or a status-only start", () => {
  const row = { ...thread("same", 1), threadStatus: "idle" as const };
  const key = navigationAttentionIdentity(row);
  let order = reconcileNavigationAttentionOrder({ threads: [row], promoteOnTurnEnd: true });
  for (const turnId of ["first", "second"]) {
    order = observeNavigationAttentionTurn({ previous: order, key, active: true, turnId, promoteOnTurnEnd: true });
    order = observeNavigationAttentionTurn({ previous: order, key, active: false, turnId, promoteOnTurnEnd: true });
  }
  order = reconcileNavigationAttentionOrder({ previous: order, threads: [row], promoteOnTurnEnd: true });
  const replay = (previous: typeof order, active: boolean) => observeNavigationAttentionTurn({ previous, key,
    active, turnId: "first", promoteOnTurnEnd: true });
  expect(replay(order, false)).toBe(order);
  expect(replay(order, true)).toBe(order);
  const status = observeNavigationAttentionTurn({ previous: order, key, active: true, promoteOnTurnEnd: true });
  expect(replay(status, false)).toBe(status);
  expect(replay(status, true)).toBe(status);
  const seen = reconcileNavigationAttentionOrder({ previous: order, threads: [{ ...row, inbox: { inInbox: false } }], promoteOnTurnEnd: true });
  expect(seen.members.has(key)).toBe(false);
});

it.each([true, false])("owns both turn boundaries between reads with promotion=%s and never promotes the later baseline again", (promoteOnTurnEnd) => {
  const idle = { ...thread("first", 1), threadStatus: "idle" as const };
  const key = navigationAttentionIdentity(idle);
  const initial = reconcileNavigationAttentionOrder({ threads: [idle], promoteOnTurnEnd });
  const started = observeNavigationAttentionTurn({ previous: initial, key, active: true, turnId: "turn-1", promoteOnTurnEnd });
  const finished = observeNavigationAttentionTurn({ previous: started, key, active: false, turnId: "turn-1", promoteOnTurnEnd });
  expect(started.members.get(key)?.rank).toBe(initial.nextRank);
  expect(finished.members.get(key)?.rank).toBe(initial.nextRank + Number(promoteOnTurnEnd));
  const duplicate = observeNavigationAttentionTurn({ previous: finished, key, active: false, turnId: "turn-1", promoteOnTurnEnd });
  expect(duplicate).toBe(finished);
  const baseline = reconcileNavigationAttentionOrder({ previous: finished, threads: [{ ...idle, updatedAt: 100 }], promoteOnTurnEnd });
  const laterOverlay = reconcileNavigationAttentionOrder({ previous: baseline, threads: [{ ...idle, updatedAt: 101 }], promoteOnTurnEnd });
  expect(laterOverlay.members.get(key)?.rank).toBe(finished.members.get(key)?.rank);
  expect(laterOverlay.nextRank).toBe(finished.nextRank);
});

it("attaches a turn id to a preceding active-status boundary without moving twice", () => {
  const idle = { ...thread("first", 1), threadStatus: "idle" as const };
  const key = navigationAttentionIdentity(idle);
  const initial = reconcileNavigationAttentionOrder({ threads: [idle], promoteOnTurnEnd: true });
  const status = observeNavigationAttentionTurn({ previous: initial, key, active: true, promoteOnTurnEnd: true });
  const started = observeNavigationAttentionTurn({ previous: status, key, active: true, turnId: "turn-1", promoteOnTurnEnd: true });
  expect(started.nextRank).toBe(status.nextRank);
  expect(started.members.get(key)?.rank).toBe(status.members.get(key)?.rank);
  const oldCompletion = observeNavigationAttentionTurn({ previous: started, key, active: false, turnId: "old-turn", promoteOnTurnEnd: true });
  expect(oldCompletion).toBe(started);
  const idleStatus = observeNavigationAttentionTurn({ previous: status, key, active: false, promoteOnTurnEnd: true });
  const baseline = reconcileNavigationAttentionOrder({ previous: idleStatus, threads: [{ ...idle, updatedAt: 100 }], promoteOnTurnEnd: true });
  expect(baseline.members.get(key)?.rank).toBe(idleStatus.members.get(key)?.rank);
});

it("retains an accepted turn's rank before provider list visibility and removes it after an authoritative seen baseline", () => {
  const first = thread("first", 1);
  const key = navigationAttentionIdentity(first);
  const started = observeNavigationAttentionTurn({ previous: { members: new Map(), nextRank: 1 }, key,
    active: true, turnId: "turn-1", promoteOnTurnEnd: true });
  const missing = reconcileNavigationAttentionOrder({ previous: started, threads: [], promoteOnTurnEnd: true });
  expect(missing.members.get(key)?.rank).toBe(1);
  const visible = reconcileNavigationAttentionOrder({ previous: missing, threads: [first], promoteOnTurnEnd: true });
  expect(visible.members.get(key)?.rank).toBe(1);
  const finished = observeNavigationAttentionTurn({ previous: visible, key, active: false, turnId: "turn-1", promoteOnTurnEnd: true });
  const seen = reconcileNavigationAttentionOrder({ previous: finished, threads: [{ ...first, threadStatus: "idle", inbox: { inInbox: false } }], promoteOnTurnEnd: true });
  expect(seen.members.has(key)).toBe(false);
});

it("keeps unseen Attention members and their ranks across incomplete owner coverage", () => {
  const first = thread("first", 1);
  const second = thread("second", 2);
  const initial = reconcileNavigationAttentionOrder({ threads: [first, second], promoteOnTurnEnd: true });
  const partial = reconcileNavigationAttentionOrder({ previous: initial, threads: [second], complete: false, promoteOnTurnEnd: true });
  expect(partial.members).toEqual(initial.members);
  const restored = reconcileNavigationAttentionOrder({ previous: partial, threads: [second, first], promoteOnTurnEnd: true });
  expect(restored.members).toEqual(initial.members);
  expect(restored.nextRank).toBe(initial.nextRank);
  const removed = reconcileNavigationAttentionOrder({ previous: restored, threads: [second], promoteOnTurnEnd: true });
  expect(removed.members.has(navigationAttentionIdentity(first))).toBe(false);
});

it("an explicit seen member can leave during partial coverage without pruning other owners", () => {
  const first = thread("first", 1);
  const second = thread("second", 2);
  const initial = reconcileNavigationAttentionOrder({ threads: [first, second], promoteOnTurnEnd: true });
  const updated = reconcileNavigationAttentionOrder({ previous: initial, threads: [{ ...first, threadStatus: "idle", inbox: { inInbox: false } }],
    complete: false, promoteOnTurnEnd: true });
  expect([...updated.members.keys()]).toEqual([navigationAttentionIdentity(second)]);
});
