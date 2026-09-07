import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { navigationAttentionIdentity, reconcileNavigationAttentionOrder } from "../app-server/navigation-attention-order";

const thread = (id: string, updatedAt: number): NavigationThreadSummary => ({ id, source: "codex", title: id, titleSource: "fallback",
  linkedDirectories: [], updatedAt, threadStatus: "active", inbox: { inInbox: true } });

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
