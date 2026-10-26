import type {
  FederationCapability,
  NavigationThreadSummary,
  SetQueuedTurnPausedRequest,
  SetQueuedTurnPausedResponse,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  canPauseQueuedTurn,
  canResumeQueuedTurn,
  queuedTurnOwnerCanPause,
  requestOwnerQueuedTurnPause,
  withOwnerPause,
  withOwnerPauseState,
} from "../queued-turn-pause";
import { getNextReleasableQueuedTurn } from "../useComposerDraftStore";

const target = { scope: "remote" as const, instanceId: "owner" };
const thread = (capabilities?: FederationCapability[]): NavigationThreadSummary => ({
  id: "thread-1", title: "Remote", titleSource: "explicit", source: "codex",
  linkedDirectories: [], inbox: { inInbox: false },
  ...(capabilities
    ? { federation: { instanceLabel: "Owner", ref: { backend: "codex", threadId: "thread-1", target }, capabilities } }
    : {}),
});

/** A desktopApi whose owner answers each pause from `answers`, in order. */
function ownerApi(...answers: (SetQueuedTurnPausedResponse | Error)[]) {
  const setQueuedTurnPaused = vi.fn(
    async (_request: SetQueuedTurnPausedRequest): Promise<SetQueuedTurnPausedResponse> => {
      const answer = answers.shift();
      if (!answer) throw new Error("No more answers.");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  );
  return { desktopApi: { setQueuedTurnPaused } as unknown as DesktopApi, setQueuedTurnPaused };
}

describe("canPauseQueuedTurn", () => {
  const now = 1_000;

  it("offers Pause on a message plainly waiting, in the owner's FIFO or this composer", () => {
    expect(canPauseQueuedTurn({ queueEntryId: "a" }, now, true)).toBe(true);
    expect(canPauseQueuedTurn({}, now, false)).toBe(true);
    // A schedule that has come due is waiting like any other row.
    expect(canPauseQueuedTurn({ queueEntryId: "a", scheduledSendAt: now }, now, true)).toBe(true);
  });

  it("offers no Pause on a row that already waits on something else", () => {
    for (const row of [
      { queueEntryId: "a", paused: true },
      { queueEntryId: "a", manualReleaseRequired: true },
      { queueEntryId: "a", errorMessage: "Failed" },
      { queueEntryId: "a", backendQueuePending: true },
      { queueEntryId: "a", steerDelivery: "sending" as const },
      { queueEntryId: "a", waitingForScheduledActionId: "action" },
      { queueEntryId: "a", reviewCommand: {} },
      { queueEntryId: "a", scheduledSendAt: now + 1 },
      { scheduledActionId: "action" },
    ]) {
      expect(canPauseQueuedTurn(row, now, true)).toBe(false);
    }
    expect(canPauseQueuedTurn({ queueEntryId: "a" }, now, false)).toBe(false);
  });
});

describe("canResumeQueuedTurn", () => {
  it("resumes a paused row, including one a hold reached, when its owner can pause", () => {
    expect(canResumeQueuedTurn({ paused: true }, false)).toBe(true);
    expect(canResumeQueuedTurn({ paused: true, queueEntryId: "a", manualReleaseRequired: true }, true)).toBe(true);
    expect(canResumeQueuedTurn({ paused: true, queueEntryId: "a" }, false)).toBe(false);
    expect(canResumeQueuedTurn({ queueEntryId: "a" }, true)).toBe(false);
  });
});

describe("getNextReleasableQueuedTurn", () => {
  it("passes over a paused turn to the next one", () => {
    expect(getNextReleasableQueuedTurn([
      { id: "a", paused: true },
      { id: "b" },
    ])).toMatchObject({ id: "b" });
    expect(getNextReleasableQueuedTurn([{ id: "a", paused: true }])).toBeUndefined();
  });

  it("still waits behind an owner entry that is not paused", () => {
    expect(getNextReleasableQueuedTurn([
      { id: "a", paused: true, queueEntryId: "a" },
      { id: "b", queueEntryId: "b" },
      { id: "c" },
    ])).toBeUndefined();
  });
});

describe("requestOwnerQueuedTurnPause", () => {
  it("asks the owner and reports what it answered", async () => {
    const { desktopApi, setQueuedTurnPaused } = ownerApi(
      { queueEntryId: "a", disposition: "updated", paused: true },
      { queueEntryId: "a", disposition: "held", paused: false },
      { queueEntryId: "a", disposition: "not_found" },
    );

    expect(await requestOwnerQueuedTurnPause({
      desktopApi,
      federationTarget: target,
      queueEntryId: "a",
      paused: true,
    })).toEqual({ failure: undefined, paused: true });
    expect(setQueuedTurnPaused).toHaveBeenCalledWith({ federationTarget: target, queueEntryId: "a", paused: true });
    expect(await requestOwnerQueuedTurnPause({ desktopApi, queueEntryId: "a", paused: true })).toEqual({
      failure: "A message held for retry can’t pause. Retry or delete it first.",
      paused: false,
    });
    expect(await requestOwnerQueuedTurnPause({ desktopApi, queueEntryId: "a", paused: false })).toEqual({
      failure: "That message already started or was removed.",
    });
  });

  it("reports a failed request and a missing bridge", async () => {
    const { desktopApi } = ownerApi(new Error("Update PwrAgent on the owning instance to pause its queued messages."));

    expect(await requestOwnerQueuedTurnPause({ desktopApi, queueEntryId: "a", paused: true })).toEqual({
      failure: "Update PwrAgent on the owning instance to pause its queued messages.",
    });
    expect(await requestOwnerQueuedTurnPause({ queueEntryId: "a", paused: true })).toEqual({
      failure: "Pausing queued messages is unavailable.",
    });
  });
});

describe("withOwnerPauseState", () => {
  it("sets the owner's answer on its row, and is undefined when no row disagrees", () => {
    const turns = [{ id: "x", queueEntryId: "a" }, { id: "y", queueEntryId: "b", paused: true }];

    expect(withOwnerPauseState(turns, "a", { paused: true })).toEqual([
      { id: "x", queueEntryId: "a", paused: true },
      turns[1],
    ]);
    expect(withOwnerPauseState(turns, "b", { paused: false })).toEqual([turns[0], { id: "y", queueEntryId: "b" }]);
    expect(withOwnerPauseState(turns, "b", { paused: true })).toBeUndefined();
    expect(withOwnerPauseState(turns, "gone", { paused: true })).toBeUndefined();
  });
});

describe("withOwnerPause", () => {
  it("applies a read at or after the row's revision, and keeps the row against an older one", () => {
    const row = { id: "x", queueEntryId: "a", paused: true, pauseRevision: 2 };

    // A queue read that left before the pause landed after it.
    expect(withOwnerPause(row, { paused: false, pauseRevision: 1 })).toBe(row);
    expect(withOwnerPause(row, { paused: false })).toBe(row);
    expect(withOwnerPause(row, { paused: false, pauseRevision: 3 })).toEqual({ id: "x", queueEntryId: "a", pauseRevision: 3 });
    expect(withOwnerPause(row, { paused: true, pauseRevision: 2 })).toEqual(row);
  });

  it("applies every read from an owner that predates revisions", () => {
    const unpaused: { id: string; paused?: boolean } = { id: "x" };
    const paused: { id: string; paused?: boolean } = { id: "x", paused: true };

    expect(withOwnerPause(unpaused, { paused: true })).toEqual({ id: "x", paused: true });
    expect(withOwnerPause(paused, {})).toEqual({ id: "x" });
  });
});

describe("queuedTurnOwnerCanPause", () => {
  const { desktopApi } = ownerApi();

  it("allows a local thread, and a peer that advertises pausing and turn control", () => {
    expect(queuedTurnOwnerCanPause(desktopApi, undefined)).toBe(true);
    expect(queuedTurnOwnerCanPause(desktopApi, thread())).toBe(true);
    expect(queuedTurnOwnerCanPause(desktopApi, thread(["turn_control", "turn_queue_pause"]))).toBe(true);
  });

  it("refuses a peer on an older build, a peer without turn control, and a missing bridge", () => {
    expect(queuedTurnOwnerCanPause(desktopApi, thread(["turn_control", "turn_queue_reorder"]))).toBe(false);
    expect(queuedTurnOwnerCanPause(desktopApi, thread(["turn_queue_pause"]))).toBe(false);
    expect(queuedTurnOwnerCanPause({} as DesktopApi, undefined)).toBe(false);
  });
});
