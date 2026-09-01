import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadReplay,
} from "@pwragent/shared";
import {
  fitNormalizedReplayWithinByteBudget,
  pageNormalizedReplay,
  threadReplayCursorIdSpace,
} from "../app-server/thread-replay-pagination";

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

  it("uses bounded entry paging when turn metadata is only partial", () => {
    const replay = buildReplay([
      legacyEntry("legacy-user", "user", "Question one"),
      turnEntry("turn-1", "assistant", "Answer one", "final"),
      turnEntry("turn-2", "user", "Question two"),
      turnEntry("turn-2", "assistant", "Answer two", "final"),
    ]);

    const page = pageNormalizedReplay(replay, { limit: 2 });

    expect(page.entries.map((entry) => entry.id)).toEqual([
      "turn-2-user-Question two",
      "turn-2-assistant-Answer two",
    ]);
    expect(page.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: true,
      previousCursor: "turn-2-user-Question two",
    });
  });
});


describe("thread replay pagination cursor id space", () => {
  it("names a provider entry when overlay rows lead the page", () => {
    // Entry-count paging, because the legacy rows carry no turn metadata. Its
    // cut lands wherever the count falls, including on the persisted usage row
    // that closes the turn before it.
    const replay = buildReplay([
      legacyEntry("legacy-user-1", "user", "Question one"),
      legacyEntry("legacy-assistant-1", "assistant", "Answer one"),
      usageEntry("turn-1"),
      legacyEntry("legacy-user-2", "user", "Question two"),
      legacyEntry("legacy-assistant-2", "assistant", "Answer two"),
    ]);

    const page = pageNormalizedReplay(replay, { limit: 3, threadId: "thread-1" });

    expect(page.entries.map((entry) => entry.id)).toEqual([
      "live-turn-usage-turn-1",
      "legacy-user-2",
      "legacy-assistant-2",
    ]);
    expect(page.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: true,
      previousCursor: "legacy-user-2",
    });
  });

  it("reports the beginning of the thread when a cursor resolves to nothing", () => {
    const replay = buildReplay([
      turnEntry("turn-1", "user", "Question one"),
      turnEntry("turn-1", "assistant", "Answer one", "final"),
    ]);

    const page = pageNormalizedReplay(replay, {
      before: "live-turn-usage-turn-1",
      threadId: "thread-1",
    });

    // Never the newest page: a reader asking for older history would be handed
    // the history it already has, and would stop paging with nothing to show.
    expect(page.entries).toEqual([]);
    expect(page.messages).toEqual([]);
    expect(page.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: false,
    });
  });

  it("classifies cursor ownership by backend", () => {
    expect(threadReplayCursorIdSpace("acp:claude-code")).toBe("entry-id");
    expect(threadReplayCursorIdSpace("codex")).toBe("provider-cursor");
    expect(threadReplayCursorIdSpace(undefined)).toBe("provider-cursor");
  });
});

describe("thread replay federation byte budget", () => {
  it("mints a provider cursor when the trim leaves an overlay row leading", () => {
    const replay = buildReplay([
      turnEntry("turn-1", "user", "Question one"),
      turnEntry("turn-1", "assistant", "Answer one", "final"),
      usageEntry("turn-1"),
      turnEntry("turn-2", "user", "Question two"),
    ]);

    const trimmed = fitNormalizedReplayWithinByteBudget({
      cursorIdSpace: "entry-id",
      replay,
      maxBytes: 0,
      measureBytes: (candidate) =>
        candidate.entries[0]?.id === "live-turn-usage-turn-1" ? 0 : 1,
    });

    expect(trimmed.entries.map((entry) => entry.id)).toEqual([
      "live-turn-usage-turn-1",
      "turn-2-user-Question two",
    ]);
    expect(trimmed.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: true,
      previousCursor: "turn-2-user-Question two",
    });
  });

  it("keeps a natively paginated backend's own cursor", () => {
    const replay: AppServerThreadReplay = {
      ...buildReplay([
        turnEntry("turn-1", "user", "Question one"),
        turnEntry("turn-2", "user", "Question two"),
      ]),
      pagination: {
        supportsPagination: true,
        hasPreviousPage: true,
        previousCursor: "opaque-turns-list-cursor",
      },
    };

    const trimmed = fitNormalizedReplayWithinByteBudget({
      cursorIdSpace: "provider-cursor",
      replay,
      maxBytes: 0,
      measureBytes: (candidate) => (candidate.entries.length > 1 ? 1 : 0),
    });

    expect(trimmed.entries.map((entry) => entry.id)).toEqual([
      "turn-2-user-Question two",
    ]);
    // An entry id is not a `thread/turns/list` cursor, so the trim leaves the
    // backend's own cursor alone rather than substituting one.
    expect(trimmed.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: true,
      previousCursor: "opaque-turns-list-cursor",
    });
  });

  it("stops trimming at the newest provider entry rather than lose the cursor", () => {
    const replay = buildReplay([
      turnEntry("turn-1", "user", "Question one"),
      turnEntry("turn-1", "assistant", "Answer one", "final"),
      usageEntry("turn-1"),
    ]);

    // Nothing fits, so the trim runs to its floor and the oversized-entry
    // compaction takes over. A page trimmed down to the usage row alone would
    // report previous history with no id left to ask for it.
    const trimmed = fitNormalizedReplayWithinByteBudget({
      cursorIdSpace: "entry-id",
      replay,
      maxBytes: 0,
      measureBytes: (candidate) =>
        candidate.entries[0]?.type === "message"
        && candidate.entries[0].text.startsWith("Content omitted")
          ? 0
          : 1,
    });

    expect(trimmed.entries.map((entry) => entry.id)).toEqual([
      "turn-1-assistant-Answer one",
    ]);
    expect(trimmed.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: true,
      previousCursor: "turn-1-assistant-Answer one",
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

function legacyEntry(
  id: string,
  role: "assistant" | "user",
  text: string,
): AppServerThreadEntry {
  return {
    type: "message",
    id,
    role,
    text,
  };
}

function usageEntry(turnId: string): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: `live-turn-usage-${turnId}`,
    summary: "Turn usage: 100 uncached in · 20 out",
    status: "completed",
    details: [],
    turn: {
      id: turnId,
      status: "completed",
    },
  };
}
