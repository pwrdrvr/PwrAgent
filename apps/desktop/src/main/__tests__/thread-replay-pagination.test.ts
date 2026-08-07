import { describe, expect, it } from "vitest";
import type {
  AppServerThreadEntry,
  AppServerThreadReplay,
} from "@pwragent/shared";
import { pageNormalizedReplay } from "../app-server/thread-replay-pagination";

describe("thread replay pagination", () => {
  it("keeps complete turns when a backend needs synthetic pagination", () => {
    const replay = buildReplay([
      turnEntry("turn-1", "user", "Question one"),
      turnEntry("turn-1", "assistant", "Working one", "commentary"),
      turnEntry("turn-1", "assistant", "Answer one", "final"),
      turnEntry("turn-2", "user", "Question two"),
      turnEntry("turn-2", "assistant", "Working two", "commentary"),
      turnEntry("turn-2", "assistant", "Answer two", "final"),
    ]);

    const page = pageNormalizedReplay(replay, { limit: 2 });

    expect(page.entries.map((entry) => entry.id)).toEqual([
      "turn-1-user-Question one",
      "turn-1-assistant-Working one",
      "turn-1-assistant-Answer one",
      "turn-2-user-Question two",
      "turn-2-assistant-Working two",
      "turn-2-assistant-Answer two",
    ]);
    expect(page.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: false,
    });
  });

  it("starts a synthetic page at the first entry of its oldest retained turn", () => {
    const replay = buildReplay([
      turnEntry("turn-1", "user", "Question one"),
      turnEntry("turn-1", "assistant", "Answer one", "final"),
      turnEntry("turn-2", "user", "Question two"),
      turnEntry("turn-2", "assistant", "Working two", "commentary"),
      turnEntry("turn-2", "assistant", "Answer two", "final"),
      turnEntry("turn-3", "user", "Question three"),
      turnEntry("turn-3", "assistant", "Answer three", "final"),
    ]);

    const page = pageNormalizedReplay(replay, { limit: 2 });

    expect(page.entries.map((entry) => entry.id)).toEqual([
      "turn-2-user-Question two",
      "turn-2-assistant-Working two",
      "turn-2-assistant-Answer two",
      "turn-3-user-Question three",
      "turn-3-assistant-Answer three",
    ]);
    expect(page.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: true,
      previousCursor: "turn-2-user-Question two",
    });
  });
});

function buildReplay(entries: AppServerThreadEntry[]): AppServerThreadReplay {
  return {
    entries,
    messages: entries.flatMap((entry) =>
      entry.type === "message"
        ? [{
            id: entry.id,
            role: entry.role,
            text: entry.text,
            ...(entry.phase ? { phase: entry.phase } : {}),
            ...(entry.turn ? { turn: entry.turn } : {}),
          }]
        : [],
    ),
    pagination: {
      supportsPagination: false,
      hasPreviousPage: false,
    },
  };
}

function turnEntry(
  turnId: string,
  role: "assistant" | "user",
  text: string,
  phase?: "commentary" | "final",
): AppServerThreadEntry {
  return {
    type: "message",
    id: `${turnId}-${role}-${text}`,
    role,
    text,
    ...(phase ? { phase } : {}),
    turn: {
      id: turnId,
      status: "completed",
    },
  };
}
