import type {
  FederationCapability,
  MoveQueuedTurnRequest,
  MoveQueuedTurnResponse,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  planQueuedTurnMove,
  queuedMoveAnchor,
  queuedTurnOwnerCanMove,
  requestOwnerQueuedTurnMove,
  settleQueuedTurnMove,
  withOwnerQueueOrder,
} from "../queued-turn-move";

const owner = (id: string) => ({ id, queueEntryId: id });
const local = (id: string) => ({ id });
const ids = (turns: readonly { id: string }[]): string[] => turns.map((turn) => turn.id);

const target = { scope: "remote" as const, instanceId: "owner" };
const thread = (capabilities?: FederationCapability[]): NavigationThreadSummary => ({
  id: "thread-1", title: "Remote", titleSource: "explicit", source: "codex",
  linkedDirectories: [], inbox: { inInbox: false },
  ...(capabilities
    ? { federation: { instanceLabel: "Owner", ref: { backend: "codex", threadId: "thread-1", target }, capabilities } }
    : {}),
});

/** A desktopApi whose owner answers each move from `answers`, in order. */
function ownerApi(...answers: (MoveQueuedTurnResponse | Error)[]) {
  const moveQueuedTurn = vi.fn(async (_request: MoveQueuedTurnRequest): Promise<MoveQueuedTurnResponse> => {
    const answer = answers.shift();
    if (!answer) throw new Error("No more answers.");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { desktopApi: { moveQueuedTurn } as unknown as DesktopApi, moveQueuedTurn };
}

describe("queued turn moves", () => {
  it("lands in front of the row the band showed, even when the store list differs", () => {
    const band = ["a", "b", "c", "d"];
    // Dropping d at index 1 of the band puts it in front of b.
    const beforeId = queuedMoveAnchor(band, "d", 1);
    expect(beforeId).toBe("b");
    // The store has no row a; an index would land d one place late.
    const plan = planQueuedTurnMove([owner("b"), owner("c"), owner("d")], "d", beforeId);
    expect(ids(plan!.next)).toEqual(["d", "b", "c"]);
    expect(plan).toMatchObject({
      queueEntryId: "d",
      beforeQueueEntryId: "b",
      ownerOrder: ["b", "c", "d"],
      plannedOrder: ["d", "b", "c"],
    });
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
});

describe("settling a move", () => {
  it("drops the marker of an accepted move, and restores the owner's order on a refusal", () => {
    const plan = planQueuedTurnMove([owner("a"), owner("b"), owner("c")], "c", "a")!;
    expect(ids(plan.next)).toEqual(["c", "a", "b"]);

    const accepted = settleQueuedTurnMove(plan.next, "c", plan.requestId, {}, plan.ownerOrder)!;
    expect(ids(accepted)).toEqual(["c", "a", "b"]);
    expect(accepted.some((turn) => "pendingMove" in turn)).toBe(false);

    // No order in the answer (the request threw): the order before the move.
    const failed = settleQueuedTurnMove(plan.next, "c", plan.requestId, { failure: "No." }, plan.ownerOrder)!;
    expect(ids(failed)).toEqual(["a", "b", "c"]);
    // The owner's own order wins over the remembered one.
    const refused = settleQueuedTurnMove(
      plan.next, "c", plan.requestId, { failure: "Held.", queueEntryIds: ["b", "a", "c"] }, plan.ownerOrder,
    )!;
    expect(ids(refused)).toEqual(["b", "a", "c"]);
  });

  it("ignores an answer for a row that started while the request was in transit", () => {
    const plan = planQueuedTurnMove([owner("a"), owner("b"), owner("c")], "c", "a")!;
    // The next queue read removed c: it dispatched before the owner moved it.
    const afterRead = plan.next.filter((turn) => turn.id !== "c");
    expect(settleQueuedTurnMove(
      afterRead, "c", plan.requestId, { failure: "That message already started or was removed." }, plan.ownerOrder,
    )).toBeUndefined();
  });

  it("lets only the latest move of a row settle it", () => {
    const first = planQueuedTurnMove([owner("a"), owner("b"), owner("c")], "c", "b")!;
    const second = planQueuedTurnMove(first.next, "c", "a")!;
    expect(ids(second.next)).toEqual(["c", "a", "b"]);

    // The first request fails after the second was sent: it must not undo it.
    expect(settleQueuedTurnMove(second.next, "c", first.requestId, { failure: "No." }, first.ownerOrder))
      .toBeUndefined();
    const settled = settleQueuedTurnMove(second.next, "c", second.requestId, {}, second.ownerOrder)!;
    expect(ids(settled)).toEqual(["c", "a", "b"]);
    expect(settled[0]).not.toHaveProperty("pendingMove");
  });
});

describe("requestOwnerQueuedTurnMove", () => {
  it("re-aims at the next planned entry when its anchor dispatched in transit", async () => {
    const { desktopApi, moveQueuedTurn } = ownerApi(
      // b, the anchor, started between the drop and the owner's lock.
      { queueEntryId: "d", disposition: "anchor_not_found", queueEntryIds: ["c", "d"] },
      { queueEntryId: "d", disposition: "moved", queueEntryIds: ["d", "c"] },
    );
    const answer = await requestOwnerQueuedTurnMove({
      desktopApi, federationTarget: target, queueEntryId: "d", beforeQueueEntryId: "b",
      plannedOrder: ["a", "d", "b", "c"],
    });
    expect(answer).toEqual({ failure: undefined, queueEntryIds: ["d", "c"] });
    expect(moveQueuedTurn.mock.calls.map(([request]) => request)).toEqual([
      { federationTarget: target, queueEntryId: "d", beforeQueueEntryId: "b" },
      { federationTarget: target, queueEntryId: "d", beforeQueueEntryId: "c" },
    ]);
  });

  it("moves to the end when every planned entry after it has left", async () => {
    const { desktopApi, moveQueuedTurn } = ownerApi(
      { queueEntryId: "a", disposition: "anchor_not_found", queueEntryIds: ["a", "x"] },
      { queueEntryId: "a", disposition: "moved", queueEntryIds: ["x", "a"] },
    );
    await requestOwnerQueuedTurnMove({
      desktopApi, queueEntryId: "a", beforeQueueEntryId: "b", plannedOrder: ["x", "a", "b"],
    });
    expect(moveQueuedTurn.mock.calls[1]?.[0]).toEqual({ queueEntryId: "a" });
  });

  it("stops re-aiming after two tries and reports the queue changed", async () => {
    const changed = (queueEntryIds: string[]): MoveQueuedTurnResponse =>
      ({ queueEntryId: "a", disposition: "anchor_not_found", queueEntryIds });
    const { desktopApi, moveQueuedTurn } = ownerApi(
      changed(["a", "c", "d"]), changed(["a", "d"]), changed(["a"]),
    );
    const answer = await requestOwnerQueuedTurnMove({
      desktopApi, queueEntryId: "a", beforeQueueEntryId: "b", plannedOrder: ["a", "b", "c", "d"],
    });
    expect(moveQueuedTurn).toHaveBeenCalledTimes(3);
    expect(answer).toEqual({
      failure: "The queue changed while that message moved. Try again.",
      queueEntryIds: ["a"],
    });
  });

  it("reports a moved entry that already started, without re-aiming", async () => {
    const { desktopApi, moveQueuedTurn } = ownerApi({ queueEntryId: "a", disposition: "not_found" });
    expect(await requestOwnerQueuedTurnMove({
      desktopApi, queueEntryId: "a", beforeQueueEntryId: "b", plannedOrder: ["a", "b"],
    })).toEqual({ failure: "That message already started or was removed.", queueEntryIds: undefined });
    expect(moveQueuedTurn).toHaveBeenCalledTimes(1);
  });

  it("turns a rejected request into a failure", async () => {
    const { desktopApi } = ownerApi(new Error("Update PwrAgent on the owning instance to reorder its queued messages."));
    expect(await requestOwnerQueuedTurnMove({ desktopApi, queueEntryId: "a" })).toEqual({
      failure: "Update PwrAgent on the owning instance to reorder its queued messages.",
    });
    expect(await requestOwnerQueuedTurnMove({ queueEntryId: "a" })).toEqual({
      failure: "Reordering queued messages is unavailable.",
    });
  });
});

describe("queuedTurnOwnerCanMove", () => {
  const { desktopApi } = ownerApi();

  it("allows a local thread, and a peer that advertises reordering and turn control", () => {
    expect(queuedTurnOwnerCanMove(desktopApi, undefined)).toBe(true);
    expect(queuedTurnOwnerCanMove(desktopApi, thread())).toBe(true);
    expect(queuedTurnOwnerCanMove(desktopApi, thread(["turn_control", "turn_queue_reorder"]))).toBe(true);
  });

  it("refuses a peer on an older build, a peer without turn control, and a missing bridge", () => {
    expect(queuedTurnOwnerCanMove(desktopApi, thread(["turn_control"]))).toBe(false);
    expect(queuedTurnOwnerCanMove(desktopApi, thread(["turn_queue_reorder"]))).toBe(false);
    expect(queuedTurnOwnerCanMove(desktopApi, { ...thread(), federation: thread([]).federation })).toBe(false);
    expect(queuedTurnOwnerCanMove({} as DesktopApi, undefined)).toBe(false);
  });
});
