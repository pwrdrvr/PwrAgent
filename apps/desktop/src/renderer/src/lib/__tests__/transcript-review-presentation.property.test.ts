import type { AppServerReadThreadResponse, AppServerThreadEntry, AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import fc from "fast-check";
import { expect, it } from "vitest";
import { combineTranscriptEntries, createTranscriptHistoryIndex, createTranscriptReviewPresentation, prependTranscriptHistoryPage } from "../segmented-transcript";
import { createTranscriptReviewHistoryIndex, deriveTranscriptReviewPresentation } from "../transcript-review-presentation";

const assistant = (id: string, text: string, turnId: string): AppServerThreadMessageEntry => ({
  type: "message", id, role: "assistant", text, turn: { id: turnId, status: "completed" },
});
function replay(entries: AppServerThreadEntry[]): AppServerReadThreadResponse {
  return {
    backend: "claude", threadId: "fixture", fetchedAt: 1,
    replay: {
      entries,
      messages: entries.filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message"),
      pagination: { supportsPagination: true, hasPreviousPage: false },
    },
  };
}

it("keeping a review artifact cannot hide an identically worded answer with a different authoritative turn", () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }), (body) => {
    const text = `No issues found. ${body}`;
    const earlier = assistant("earlier-answer", text, "conversation-turn");
    const review: AppServerThreadEntry = {
      id: "review", type: "review", review: text, turn: { id: "review-turn", status: "completed" },
    };
    const display = deriveTranscriptReviewPresentation({
      historyEvents: [], historyIndex: createTranscriptReviewHistoryIndex(),
      tailEntries: [earlier, review], tailMessages: [earlier],
    });
    expect(display.tailEntries.map((entry) => entry.id)).toEqual(["earlier-answer", "review"]);
    expect(display.tailMessages.map((entry) => entry.id)).toEqual(["earlier-answer"]);
  }));
});

it("filtering a generated prompt that exists only in the live tail preserves earlier paged entries", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), (count) => {
    const oldRows = Array.from({ length: count }, (_, index) => assistant(`earlier-${index}`, "Earlier answer", `earlier-turn-${index}`));
    const tail: AppServerThreadEntry[] = [
      { type: "message", id: "generated-request", role: "user",
        text: "<pwragent-inline-review-instructions>\nInspect this diff.\n</pwragent-inline-review-instructions>",
        turn: { id: "review-turn", status: "completed" } },
      { id: "review", type: "review", review: "One finding.", turn: { id: "review-turn", status: "completed" } },
    ];
    const index = createTranscriptHistoryIndex();
    const history = prependTranscriptHistoryPage({
      history: undefined, index, page: replay(oldRows), tailEntries: tail,
    });
    const presentation = createTranscriptReviewPresentation({
      history, index, tailEntries: tail, tailMessages: replay(tail).replay.messages,
    });
    const expected = [...oldRows.map((entry) => entry.id), "review"];
    const display = combineTranscriptEntries(history, index, presentation.tailEntries, presentation);
    expect({ length: display.length, rows: display.slice().map((entry) => entry.id) })
      .toEqual({ length: expected.length, rows: expected });
  }));
});

it("does not revisit completed reviews in earlier pages for a new turn's live rows", () => {
  fc.assert(fc.property(fc.integer({ min: 20, max: 80 }), (size) => {
    let historicalVisits = 0;
    const oldRows = Array.from({ length: size }, (_, index): AppServerThreadEntry => ({
      get type() { historicalVisits++; return "review" as const; },
      id: `old-review-${index}`, review: "No findings.", turn: { id: `old-turn-${index}`, status: "completed" },
    }));
    const index = createTranscriptHistoryIndex();
    const history = prependTranscriptHistoryPage({
      history: undefined, index, page: replay(oldRows), tailEntries: [],
    });
    createTranscriptReviewPresentation({ history, index, tailEntries: [], tailMessages: [] });
    historicalVisits = 0;
    const newReview: AppServerThreadEntry = {
      type: "review", id: "new-review", review: "No findings.", turn: { id: "live-turn", status: "completed" },
    };
    for (let update = 0; update < 8; update++) {
      const reply = assistant("live-answer", `Ordinary live answer ${update}`, "live-turn");
      const created = createTranscriptReviewPresentation({
        history, index, tailEntries: [newReview, reply], tailMessages: [reply],
      });
      expect(created.tailEntries.map((entry) => entry.id)).toEqual([newReview.id, reply.id]);
      expect(combineTranscriptEntries(history, index, created.tailEntries, created).length).toBe(size + 2);
    }
    expect(historicalVisits).toBe(0);
  }));
});
