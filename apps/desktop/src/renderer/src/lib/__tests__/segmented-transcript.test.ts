import type {
  AppServerReadThreadResponse,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  combineTranscriptEntries,
  combineTranscriptResponse,
  createTranscriptHistoryIndex,
  prependTranscriptHistoryPage,
  type LoadedTranscriptHistory,
  type TranscriptHistoryPage,
} from "../segmented-transcript";

function message(
  id: string,
  text = id,
  extras: Partial<AppServerThreadMessageEntry> = {},
): AppServerThreadMessageEntry {
  return {
    type: "message",
    id,
    role: "assistant",
    text,
    ...extras,
  };
}

function turnUsage(params: {
  createdAt: number;
  summary: string;
  turnId: string;
}): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: `live-turn-usage-${params.turnId}`,
    summary: params.summary,
    status: "completed",
    createdAt: params.createdAt,
    details: [],
    turn: {
      id: params.turnId,
      status: "completed",
    },
  };
}

function response(
  entries: AppServerThreadEntry[],
  previousCursor?: string,
): AppServerReadThreadResponse {
  return {
    backend: "codex",
    fetchedAt: 1,
    threadId: "thread-1",
    replay: {
      entries,
      messages: entries.flatMap((entry) =>
        entry.type === "message"
          ? [{
              id: entry.id,
              role: entry.role,
              text: entry.text,
            }]
          : []
      ),
      pagination: {
        supportsPagination: true,
        hasPreviousPage: Boolean(previousCursor),
        ...(previousCursor ? { previousCursor } : {}),
      },
    },
  };
}

function historyPages(
  history: LoadedTranscriptHistory | undefined,
): TranscriptHistoryPage[] {
  const pages: TranscriptHistoryPage[] = [];
  let page = history?.oldestPage;
  while (page) {
    pages.push(page);
    page = page.newerPage;
  }
  return pages;
}

describe("segmented transcript history", () => {
  it("keeps array behavior while the tail remains authoritative by exact id", () => {
    const index = createTranscriptHistoryIndex();
    const tail = [message("tail", "Authoritative tail")];
    const history = prependTranscriptHistoryPage({
      history: undefined,
      index,
      page: response([
        message("older", "Repeated"),
        message("repeat-distinct", "Repeated"),
        message("tail", "Stale overlap"),
      ]),
      tailEntries: tail,
    });
    const entries = combineTranscriptEntries(history, index, tail);

    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.id)).toEqual([
      "older",
      "repeat-distinct",
      "tail",
    ]);
    const lastEntry = entries.at(-1);
    expect(lastEntry?.type === "message" && lastEntry.text).toBe(
      "Authoritative tail",
    );
    expect(entries.slice(-2).map((entry) => entry.id)).toEqual([
      "repeat-distinct",
      "tail",
    ]);

    const combinedResponse = combineTranscriptResponse({
      history,
      index,
      response: response(tail, "tail-cursor"),
    });
    expect(combinedResponse?.replay.messages.map((item) => item.id)).toEqual([
      "older",
      "repeat-distinct",
      "tail",
    ]);
    expect(combinedResponse?.replay.pagination.hasPreviousPage).toBe(false);
  });

  it("pins a linear history-storage work budget as pages accumulate", () => {
    const pageCount = 100;
    const entriesPerPage = 50;
    const index = createTranscriptHistoryIndex();
    let history: LoadedTranscriptHistory | undefined;
    let allocatedHistoryEntrySlots = 0;
    let copiedPriorEntrySlots = 0;

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const retainedPages = historyPages(history);
      const retainedArrays = new Set(retainedPages.map((page) => page.entries));
      history = prependTranscriptHistoryPage({
        history,
        index,
        page: response(
          Array.from({ length: entriesPerPage }, (_value, entryIndex) =>
            message(`page-${pageIndex}-entry-${entryIndex}`)
          ),
          pageIndex + 1 < pageCount ? `cursor-${pageIndex + 1}` : undefined,
        ),
        tailEntries: [],
      });

      const nextPages = historyPages(history);
      const nextArrays = new Set(nextPages.map((page) => page.entries));
      for (const retainedPage of retainedPages) {
        if (!nextArrays.has(retainedPage.entries)) {
          copiedPriorEntrySlots += retainedPage.entries.length;
        }
      }
      const newArrays = nextPages.filter(
        (page) => !retainedArrays.has(page.entries)
      );
      allocatedHistoryEntrySlots += newArrays.reduce(
        (total, page) => total + page.entries.length,
        0,
      );

      // Creating the public array view is O(1) in transcript entries. It must
      // not flatten the page chain merely to report its length.
      expect(combineTranscriptEntries(history, index, [])).toHaveLength(
        (pageIndex + 1) * entriesPerPage,
      );
    }

    const loadedEntries = pageCount * entriesPerPage;
    const legacyGrowingArrayEntryCopies =
      entriesPerPage * pageCount * (pageCount + 1) / 2;
    expect({
      allocatedHistoryEntrySlots,
      copiedPriorEntrySlots,
      loadedEntries,
    }).toEqual({
      allocatedHistoryEntrySlots: 5_000,
      copiedPriorEntrySlots: 0,
      loadedEntries: 5_000,
    });
    expect(legacyGrowingArrayEntryCopies).toBe(252_500);
  });

  it("keeps live-tail window work independent of loaded history entries", () => {
    const index = createTranscriptHistoryIndex();
    let history: LoadedTranscriptHistory | undefined;
    let retainedHistoryIdReads = 0;

    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const entries = Array.from(
        { length: 50 },
        (_value, entryIndex): AppServerThreadMessageEntry => {
          const id = `history-${pageIndex}-${entryIndex}`;
          return {
            type: "message",
            get id() {
              retainedHistoryIdReads += 1;
              return id;
            },
            role: "assistant",
            text: id,
          };
        },
      );
      history = prependTranscriptHistoryPage({
        history,
        index,
        page: response(entries, `cursor-${pageIndex}`),
        tailEntries: [],
      });
    }

    retainedHistoryIdReads = 0;
    let tail: AppServerThreadEntry[] = [];
    for (let liveIndex = 0; liveIndex < 100; liveIndex += 1) {
      tail = [...tail, message(`live-${liveIndex}`)];
      const entries = combineTranscriptEntries(history, index, tail);
      expect(entries).toHaveLength(1_000 + tail.length);
      expect(entries.slice(-1)[0]?.id).toBe(`live-${liveIndex}`);
    }

    expect(retainedHistoryIdReads).toBe(0);
  });

  it("pins linear work for reverse numeric-index searches", () => {
    const index = createTranscriptHistoryIndex();
    let history: LoadedTranscriptHistory | undefined;
    let retainedHistoryIdReads = 0;

    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const entries = Array.from(
        { length: 50 },
        (_value, entryIndex): AppServerThreadMessageEntry => {
          const id = `history-${pageIndex}-${entryIndex}`;
          return {
            type: "message",
            get id() {
              retainedHistoryIdReads += 1;
              return id;
            },
            role: "assistant",
            text: id,
          };
        },
      );
      history = prependTranscriptHistoryPage({
        history,
        index,
        page: response(entries, `cursor-${pageIndex}`),
        tailEntries: [],
      });
    }

    retainedHistoryIdReads = 0;
    const entries = combineTranscriptEntries(history, index, []);
    let found = false;
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      if (entries[entryIndex]?.id === "missing-entry") {
        found = true;
        break;
      }
    }

    expect(found).toBe(false);
    expect(retainedHistoryIdReads).toBe(2_000);
  });

  it("merges overlay turn usage into an older history page once instead of leaving it in the tail", () => {
    const olderTurn = {
      id: "older-turn",
      status: "completed" as const,
    };
    const laterOlderTurn = {
      id: "later-older-turn",
      status: "completed" as const,
    };
    const recentTurn = {
      id: "recent-turn",
      status: "completed" as const,
    };
    const environmentSetup: AppServerThreadActivityEntry = {
      type: "activity",
      id: "codex-environment-setup-pwragent",
      summary: "Environment setup completed: PwrAgent",
      status: "completed",
      details: [],
    };
    const olderUsage = turnUsage({
      createdAt: 181,
      summary: "Turn usage: 170,652 uncached in · 2,342,912 cached · 12,266 out",
      turnId: olderTurn.id,
    });
    const laterOlderUsage = turnUsage({
      createdAt: 281,
      summary: "Turn usage: 6,057 uncached in · 473,344 cached · 1,312 out",
      turnId: laterOlderTurn.id,
    });
    const recentUsage = turnUsage({
      createdAt: 481,
      summary: "Turn usage: 3,034 uncached in · 160,512 cached · 1,367 out",
      turnId: recentTurn.id,
    });
    const tail = [
      environmentSetup,
      olderUsage,
      laterOlderUsage,
      message("recent-user", "Recent prompt", {
        role: "user",
        createdAt: 400,
        turn: recentTurn,
      }),
      message("recent-final", "Recent answer", {
        createdAt: 480,
        turn: recentTurn,
      }),
      recentUsage,
    ];
    const index = createTranscriptHistoryIndex();
    const history = prependTranscriptHistoryPage({
      history: undefined,
      index,
      page: response([
        message("older-user", "Older prompt", {
          role: "user",
          createdAt: 100,
          turn: olderTurn,
        }),
        message("older-final", "Older answer", {
          createdAt: 180,
          turn: olderTurn,
        }),
        message("later-older-user", "Later older prompt", {
          role: "user",
          createdAt: 200,
          turn: laterOlderTurn,
        }),
        message("later-older-final", "Later older answer", {
          createdAt: 280,
          turn: laterOlderTurn,
        }),
      ]),
      tailEntries: tail,
    });
    const entries = combineTranscriptEntries(history, index, tail);

    expect(entries.map((entry) => entry.id)).toEqual([
      "older-user",
      "older-final",
      olderUsage.id,
      "later-older-user",
      "later-older-final",
      laterOlderUsage.id,
      environmentSetup.id,
      "recent-user",
      "recent-final",
      recentUsage.id,
    ]);
  });

  it("hides overlay usage for turns that are not in the loaded window yet", () => {
    const olderTurn = {
      id: "older-turn",
      status: "completed" as const,
    };
    const laterOlderTurn = {
      id: "later-older-turn",
      status: "completed" as const,
    };
    const recentTurn = {
      id: "recent-turn",
      status: "completed" as const,
    };
    const olderUsage = turnUsage({
      createdAt: 181,
      summary: "Turn usage: older",
      turnId: olderTurn.id,
    });
    const laterOlderUsage = turnUsage({
      createdAt: 281,
      summary: "Turn usage: later older",
      turnId: laterOlderTurn.id,
    });
    const recentUsage = turnUsage({
      createdAt: 481,
      summary: "Turn usage: recent",
      turnId: recentTurn.id,
    });
    const tail = [
      olderUsage,
      laterOlderUsage,
      message("recent-final", "Recent answer", {
        createdAt: 480,
        turn: recentTurn,
      }),
      recentUsage,
    ];

    expect(
      combineTranscriptEntries(undefined, undefined, tail).map((entry) => entry.id),
    ).toEqual(["recent-final", recentUsage.id]);

    const index = createTranscriptHistoryIndex();
    const history = prependTranscriptHistoryPage({
      history: undefined,
      index,
      page: response([
        message("later-older-final", "Later older answer", {
          createdAt: 280,
          turn: laterOlderTurn,
        }),
      ]),
      tailEntries: tail,
    });

    expect(
      combineTranscriptEntries(history, index, tail).map((entry) => entry.id),
    ).toEqual([
      "later-older-final",
      laterOlderUsage.id,
      "recent-final",
      recentUsage.id,
    ]);
  });

  it("keeps overlay usage that arrives after its historical turn is already indexed", () => {
    const olderTurn = {
      id: "older-turn",
      status: "completed" as const,
    };
    const recentTurn = {
      id: "recent-turn",
      status: "completed" as const,
    };
    const index = createTranscriptHistoryIndex();
    const history = prependTranscriptHistoryPage({
      history: undefined,
      index,
      page: response([
        message("older-final", "Older answer", {
          createdAt: 180,
          turn: olderTurn,
        }),
      ]),
      tailEntries: [
        message("recent-final", "Recent answer", {
          createdAt: 480,
          turn: recentTurn,
        }),
      ],
    });
    const lateUsage = turnUsage({
      createdAt: 181,
      summary: "Turn usage: older",
      turnId: olderTurn.id,
    });
    const tail = [
      lateUsage,
      message("recent-final", "Recent answer", {
        createdAt: 480,
        turn: recentTurn,
      }),
    ];

    expect(
      combineTranscriptEntries(history, index, tail).map((entry) => entry.id),
    ).toEqual([
      "older-final",
      lateUsage.id,
      "recent-final",
    ]);
  });

  it("does not relocate overlay usage while the same turn still has tail entries", () => {
    const splitTurn = {
      id: "split-turn",
      status: "completed" as const,
    };
    const recentTurn = {
      id: "recent-turn",
      status: "completed" as const,
    };
    const splitUsage = turnUsage({
      createdAt: 160,
      summary: "Turn usage: split",
      turnId: splitTurn.id,
    });
    const tail = [
      message("split-tail", "Later split-turn work", {
        createdAt: 150,
        turn: splitTurn,
      }),
      splitUsage,
      message("recent-final", "Recent answer", {
        createdAt: 480,
        turn: recentTurn,
      }),
    ];
    const index = createTranscriptHistoryIndex();
    const history = prependTranscriptHistoryPage({
      history: undefined,
      index,
      page: response([
        message("split-older", "Earlier split-turn work", {
          createdAt: 100,
          turn: splitTurn,
        }),
      ]),
      tailEntries: tail,
    });

    expect(
      combineTranscriptEntries(history, index, tail).map((entry) => entry.id),
    ).toEqual([
      "split-older",
      "split-tail",
      splitUsage.id,
      "recent-final",
    ]);
  });

  it("relocates overlay usage with one linear pass over the new page and tail", () => {
    const priorPageCount = 20;
    const entriesPerPage = 50;
    const index = createTranscriptHistoryIndex();
    let history: LoadedTranscriptHistory | undefined;
    let retainedHistoryIdReads = 0;

    for (let pageIndex = 0; pageIndex < priorPageCount; pageIndex += 1) {
      const entries = Array.from(
        { length: entriesPerPage },
        (_value, entryIndex): AppServerThreadMessageEntry => {
          const id = `history-${pageIndex}-${entryIndex}`;
          return {
            type: "message",
            get id() {
              retainedHistoryIdReads += 1;
              return id;
            },
            role: "assistant",
            text: id,
            turn: {
              id: `history-turn-${pageIndex}-${entryIndex}`,
              status: "completed",
            },
          };
        },
      );
      history = prependTranscriptHistoryPage({
        history,
        index,
        page: response(entries, `cursor-${pageIndex}`),
        tailEntries: [],
      });
    }

    const retainedPages = historyPages(history);
    const olderTurnIds = Array.from(
      { length: 10 },
      (_value, turnIndex) => `older-turn-${turnIndex}`,
    );
    const unmatchedTurnIds = Array.from(
      { length: 90 },
      (_value, turnIndex) => `unloaded-turn-${turnIndex}`,
    );
    const tail: AppServerThreadEntry[] = [
      ...unmatchedTurnIds.map((turnId, turnIndex) =>
        turnUsage({
          createdAt: 100 + turnIndex,
          summary: `Turn usage: ${turnId}`,
          turnId,
        }),
      ),
      ...olderTurnIds.map((turnId, turnIndex) =>
        turnUsage({
          createdAt: 1_100 + turnIndex,
          summary: `Turn usage: ${turnId}`,
          turnId,
        }),
      ),
      message("recent-final", "Recent answer", {
        createdAt: 2_000,
        turn: { id: "recent-turn", status: "completed" },
      }),
    ];
    const olderPageEntries = olderTurnIds.map((turnId, turnIndex) =>
      message(`older-final-${turnIndex}`, `Older answer ${turnIndex}`, {
        createdAt: 1_000 + turnIndex,
        turn: { id: turnId, status: "completed" },
      }),
    );

    retainedHistoryIdReads = 0;
    history = prependTranscriptHistoryPage({
      history,
      index,
      page: response(olderPageEntries, "older-cursor"),
      tailEntries: tail,
    });

    const nextPages = historyPages(history);
    const nextArrays = new Set(nextPages.map((page) => page.entries));
    let copiedPriorEntrySlots = 0;
    for (const retainedPage of retainedPages) {
      if (!nextArrays.has(retainedPage.entries)) {
        copiedPriorEntrySlots += retainedPage.entries.length;
      }
    }

    expect(copiedPriorEntrySlots).toBe(0);
    expect(retainedHistoryIdReads).toBe(0);

    const entries = combineTranscriptEntries(history, index, tail);
    expect(
      entries.slice(0, olderTurnIds.length * 2).map((entry) => entry.id),
    ).toEqual(
      olderTurnIds.flatMap((turnId, turnIndex) => [
        `older-final-${turnIndex}`,
        `live-turn-usage-${turnId}`,
      ]),
    );
    expect(entries.at(-1)?.id).toBe("recent-final");
    expect(
      entries.some((entry) => entry.id.startsWith("live-turn-usage-unloaded-")),
    ).toBe(false);
  });
});
