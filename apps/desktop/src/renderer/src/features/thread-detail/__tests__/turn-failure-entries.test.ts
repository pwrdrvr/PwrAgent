import { describe, expect, it } from "vitest";
import type {
  AppServerThreadEntry,
  ThreadTurnFailure,
} from "@pwragent/shared";
import {
  TURN_FAILURE_ENTRY_PREFIX,
  buildTurnFailureActivityEntries,
  injectTurnFailures,
  isTurnFailureEntry,
} from "../turn-failure-entries";

const f1: ThreadTurnFailure = {
  id: "fail-1",
  turnId: "turn-1",
  error: "stream disconnected before completion",
  occurredAt: 1_000,
};
const f2: ThreadTurnFailure = {
  id: "fail-2",
  turnId: "turn-2",
  error: "rate limited",
  occurredAt: 3_000,
};

describe("turn-failure-entries", () => {
  it("builds terminal-failure activity entries the transcript recognizes", () => {
    const [entry] = buildTurnFailureActivityEntries([f1]);
    expect(entry.type).toBe("activity");
    expect(entry.id).toBe(`${TURN_FAILURE_ENTRY_PREFIX}${f1.turnId}`);
    expect(isTurnFailureEntry(entry)).toBe(true);
    expect(entry.status).toBe("failed");
    expect(entry.tone).toBe("warning");
    expect(entry.summary).toBe("Turn failed");
    // `isTerminalTurnFailureActivity` requires turn.status === "failed".
    expect(entry.turn?.status).toBe("failed");
    expect(entry.createdAt).toBe(f1.occurredAt);
    expect(entry.details[0]?.label).toBe(f1.error);
  });

  it("returns the original array when failures is empty", () => {
    const original: AppServerThreadEntry[] = [];
    expect(injectTurnFailures(original, undefined)).toBe(original);
    expect(injectTurnFailures(original, [])).toBe(original);
  });

  it("orders the failure marker inline at occurredAt", () => {
    const existing: AppServerThreadEntry[] = [
      {
        type: "message",
        id: "msg-1",
        role: "user",
        phase: "final",
        createdAt: 500,
        text: "hi",
      },
      {
        type: "message",
        id: "msg-2",
        role: "assistant",
        phase: "final",
        createdAt: 2_000,
        text: "hello",
      },
    ];
    const merged = injectTurnFailures(existing, [f1]);
    expect(merged.map((entry) => entry.id)).toEqual([
      "msg-1",
      `${TURN_FAILURE_ENTRY_PREFIX}${f1.turnId}`,
      "msg-2",
    ]);
  });

  it("inserts the failure marker after a coincident existing entry", () => {
    const existing: AppServerThreadEntry[] = [
      {
        type: "message",
        id: "msg-coincident",
        role: "assistant",
        phase: "final",
        createdAt: 1_000,
        text: "hello",
      },
    ];
    const merged = injectTurnFailures(existing, [f1]);
    expect(merged.map((entry) => entry.id)).toEqual([
      "msg-coincident",
      `${TURN_FAILURE_ENTRY_PREFIX}${f1.turnId}`,
    ]);
  });

  it("dedupes against a backend that already emitted its own failure entry", () => {
    // An ACP backend persists `turn-failed:<turnId>` in its transcript;
    // the synthetic overlay entry must not double it.
    const existing: AppServerThreadEntry[] = [
      {
        type: "activity",
        id: `${TURN_FAILURE_ENTRY_PREFIX}${f1.turnId}`,
        summary: "Turn failed",
        createdAt: 1_000,
        status: "failed",
        tone: "warning",
        turn: { id: f1.turnId, status: "failed", completedAt: 1_000 },
        details: [],
      },
    ];
    const merged = injectTurnFailures(existing, [f1]);
    expect(merged).toBe(existing);
    expect(
      merged.filter(
        (entry) => entry.id === `${TURN_FAILURE_ENTRY_PREFIX}${f1.turnId}`,
      ),
    ).toHaveLength(1);
  });

  it("keeps fresh failures while skipping already-present ones", () => {
    const existing: AppServerThreadEntry[] = [
      {
        type: "activity",
        id: `${TURN_FAILURE_ENTRY_PREFIX}${f1.turnId}`,
        summary: "Turn failed",
        createdAt: 1_000,
        status: "failed",
        tone: "warning",
        turn: { id: f1.turnId, status: "failed", completedAt: 1_000 },
        details: [],
      },
    ];
    const merged = injectTurnFailures(existing, [f1, f2]);
    expect(merged.map((entry) => entry.id)).toEqual([
      `${TURN_FAILURE_ENTRY_PREFIX}${f1.turnId}`,
      `${TURN_FAILURE_ENTRY_PREFIX}${f2.turnId}`,
    ]);
  });
});
