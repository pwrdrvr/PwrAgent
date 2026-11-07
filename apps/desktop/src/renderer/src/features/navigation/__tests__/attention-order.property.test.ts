import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { createAttentionOrderState, reconcileAttentionOrder } from "../attention-order";

const ids = ["a", "b", "c", "d"];
type Operation = { kind: "start" | "activity" | "finish" | "betweenPolls" | "leave" | "return"; index: number; shuffle: string[] };

const operations = fc.array(fc.record({
  kind: fc.constantFrom<Operation["kind"]>("start", "activity", "finish", "betweenPolls", "leave", "return"),
  index: fc.nat(3),
  shuffle: fc.shuffledSubarray(ids, { minLength: ids.length, maxLength: ids.length }),
}), { maxLength: 60 });

function thread(id: string, active: boolean, updatedAt: number): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "derived", linkedDirectories: [],
    inbox: { inInbox: true }, threadStatus: active ? "active" : "idle", updatedAt };
}

describe("Attention order properties (AGENTS.md: Attention order)", () => {
  it.each([true, false])("matches turn order through shuffled rows and duplicate snapshots, promotion=%s", (promoteOnTurnEnd) => {
    fc.assert(fc.property(operations, (commands) => {
      const members = new Map(ids.map((id, index) => [id, { active: false, updatedAt: 4 - index, moves: 0 }]));
      let expected = [...ids];
      let clock = 4;
      let state = reconcileAttentionOrder({ previous: createAttentionOrderState(),
        threads: ids.map((id) => thread(id, false, members.get(id)!.updatedAt)), promoteOnTurnEnd }).state;
      for (const op of commands) {
        const id = ids[op.index]!;
        const member = members.get(id);
        let promote = false;
        switch (op.kind) {
          case "start":
            if (!member || member.active) continue;
            member.active = true;
            member.moves = 0;
            member.updatedAt = ++clock;
            promote = true;
            break;
          case "activity":
            if (!member?.active) continue;
            member.updatedAt = ++clock;
            break;
          case "finish":
            if (!member?.active) continue;
            member.active = false;
            member.updatedAt = ++clock;
            promote = promoteOnTurnEnd;
            break;
          case "betweenPolls":
            if (!member || member.active) continue;
            member.moves = 0;
            member.updatedAt = ++clock;
            promote = promoteOnTurnEnd;
            break;
          case "leave":
            if (!member || member.active) continue;
            members.delete(id);
            expected = expected.filter((key) => key !== id);
            break;
          case "return":
            if (member) continue;
            members.set(id, { active: false, updatedAt: ++clock, moves: 0 });
            promote = true;
            break;
        }
        if (promote) expected = [id, ...expected.filter((key) => key !== id)];
        const rows = op.shuffle.filter((id) => members.has(id)).map((id) => {
          const member = members.get(id)!;
          return thread(id, member.active, member.updatedAt);
        });
        const previous = state;
        const result = reconcileAttentionOrder({ previous, threads: rows, promoteOnTurnEnd });
        state = result.state;
        expect(result.threads.map((row) => row.id)).toEqual(expected);
        expect(state.entries.size).toBe(members.size);
        expect(new Set([...state.entries.values()].map((entry) => entry.rank)).size).toBe(members.size);
        expect(state.nextRank - previous.nextRank).toBe(Number(promote));
        for (const row of rows) {
          const key = threadSummaryIdentityKey(row);
          const before = previous.entries.get(key);
          if (before && state.entries.get(key)!.rank !== before.rank) {
            expect(row.id).toBe(id);
            const member = members.get(id)!;
            member.moves += 1;
            expect(member.moves).toBeLessThanOrEqual(promoteOnTurnEnd ? 2 : 1);
          }
        }
        // StrictMode and repeated deliveries cannot spend another rank.
        const duplicate = reconcileAttentionOrder({ previous: state, threads: [...rows].reverse(), promoteOnTurnEnd });
        expect(duplicate.state).toEqual(state);
        expect(duplicate.threads.map((row) => row.id)).toEqual(expected);
      }
    }));
  });

  it("live activity timestamps, including older activity samples, never mint a rank", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.nat(3), fc.nat()), { maxLength: 60 }), (updates) => {
      const rows = ids.map((id) => thread(id, true, 1));
      const initial = reconcileAttentionOrder({ previous: createAttentionOrderState(), threads: rows, promoteOnTurnEnd: true });
      let state = initial.state;
      for (const [index, updatedAt] of updates) {
        rows[index] = { ...rows[index]!, updatedAt };
        const result = reconcileAttentionOrder({ previous: state, threads: [...rows].sort((a, b) => b.updatedAt! - a.updatedAt!),
          promoteOnTurnEnd: true });
        expect(result.threads.map((row) => row.id)).toEqual(ids);
        expect(result.state.nextRank).toBe(initial.state.nextRank);
        for (const [key, entry] of result.state.entries) expect(entry.rank).toBe(initial.state.entries.get(key)!.rank);
        state = result.state;
      }
    }));
  });
});
