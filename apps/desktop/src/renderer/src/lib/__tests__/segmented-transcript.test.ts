import type {
  AppServerReadThreadResponse,
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

function message(id: string, text = id): AppServerThreadMessageEntry {
  return {
    type: "message",
    id,
    role: "assistant",
    text,
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
});
