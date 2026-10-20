import { describe, expect, it } from "vitest";
import {
  planQueuedTurnMove,
  queuedMoveAnchor,
  settleQueuedTurnMove,
  withOwnerQueueOrder,
} from "../queued-turn-move";

const owner = (id: string) => ({ id, queueEntryId: id });
const local = (id: string) => ({ id });
const ids = (turns: readonly { id: string }[]): string[] => turns.map((turn) => turn.id);

describe("queued turn moves", () => {
  it("lands in front of the row the band showed, even when the store list differs", () => {
    const band = ["a", "b", "c", "d"];
    // Dropping d at index 1 of the band puts it in front of b.
    const beforeId = queuedMoveAnchor(band, "d", 1);
    expect(beforeId).toBe("b");
    // The store has no row a; an index would land d one place late.
    const plan = planQueuedTurnMove([owner("b"), owner("c"), owner("d")], "d", beforeId);
    expect(ids(plan!.next)).toEqual(["d", "b", "c"]);
    expect(plan).toMatchObject({ queueEntryId: "d", beforeQueueEntryId: "b", ownerOrder: ["b", "c", "d"] });
    expect(queuedMoveAnchor(band, "a", 3)).toBeUndefined();
  });

  it("refuses an anchor that is gone, and a move to where the row already is", () => {
    const turns = [owner("a"), owner("b")];
    expect(planQueuedTurnMove(turns, "a", "gone")).toBeUndefined();
    expect(planQueuedTurnMove(turns, "a", "b")).toBeUndefined();
    expect(planQueuedTurnMove(turns, "b", undefined)).toBeUndefined();
  });

  it("puts owner entries back in the owner's order and leaves other rows in place", () => {
    const turns = [local("x"), owner("c"), owner("a"), local("y"), owner("b")];
    expect(ids(withOwnerQueueOrder(turns, ["a", "b", "c"]))).toEqual(["x", "a", "b", "y", "c"]);
  });

  it("settles an accepted move by dropping its marker, and a refused one by restoring the order", () => {
    const plan = planQueuedTurnMove([owner("a"), owner("b"), owner("c")], "c", "a")!;
    expect(ids(plan.next)).toEqual(["c", "a", "b"]);

    const accepted = settleQueuedTurnMove(plan.next, "c", {}, plan.ownerOrder)!;
    expect(ids(accepted)).toEqual(["c", "a", "b"]);
    expect(accepted.some((turn) => "pendingMove" in turn)).toBe(false);

    const refused = settleQueuedTurnMove(plan.next, "c", { failure: "No." }, plan.ownerOrder)!;
    expect(ids(refused)).toEqual(["a", "b", "c"]);
    const ownerAnswer = settleQueuedTurnMove(
      plan.next,
      "c",
      { failure: "Held.", queueEntryIds: ["b", "a", "c"] },
      plan.ownerOrder,
    )!;
    expect(ids(ownerAnswer)).toEqual(["b", "a", "c"]);
  });
});
