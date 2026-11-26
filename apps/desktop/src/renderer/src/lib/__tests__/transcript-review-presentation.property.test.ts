import type { AppServerReadThreadResponse, AppServerThreadEntry, AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import fc from "fast-check";
import { expect, it } from "vitest";
import { pullRequestReviewPrompt } from "../../../../shared/__tests__/fixtures/pull-request-review";
import { appendTranscriptHistoryPage, combineTranscriptEntries, combineTranscriptMessages, createTranscriptHistoryIndex, createTranscriptReviewPresentation, prependTranscriptHistoryPage } from "../segmented-transcript";
import { createTranscriptReviewHistoryIndex, deriveTranscriptReviewPresentation } from "../transcript-review-presentation";

const assistant = (id: string, text: string, turnId: string): AppServerThreadMessageEntry => ({
  type: "message", id, role: "assistant", text, turn: { id: turnId, status: "completed" },
});

it("reclassifies a stable assistant ID as its retired copy is corrected and retired again", () => {
  fc.assert(fc.property(fc.string(), fc.string(), fc.boolean(), (suffix, different, plainFindings) => {
    const duplicate = plainFindings
      ? `Review comments:\n- [P2] Check export — export.ts:12 ${suffix}`
      : `Review result ${suffix}`;
    const corrected = `Corrected reply ${different}`;
    const newest = assistant("latest", "Last answer.", "next-turn");
    const review: AppServerThreadEntry = { type: "review", id: "findings", review: duplicate, turn: { id: "review-turn" } };
    const index = createTranscriptHistoryIndex();
    let history = appendTranscriptHistoryPage({
      history: undefined, index, page: replay([review, assistant("answer", duplicate, "review-turn"), newest]), tailEntries: [],
    });
    for (const text of [corrected, duplicate, corrected]) {
      const revision = assistant("answer", text, "review-turn");
      const raw = [review, revision, newest];
      const oracle = deriveTranscriptReviewPresentation({
        historyEvents: [], historyIndex: createTranscriptReviewHistoryIndex(), tailEntries: raw, tailMessages: replay(raw).replay.messages,
      });
      for (const tail of [[revision], []]) {
        if (!tail.length) {
          history = appendTranscriptHistoryPage({ history, index, page: replay([revision]), tailEntries: [] });
        }
        const display = createTranscriptReviewPresentation({ history, index, tailEntries: tail, tailMessages: replay(tail).replay.messages });
        const entries = combineTranscriptEntries(history, index, display.tailEntries, display);
        const messages = combineTranscriptMessages(history, index, display.tailMessages, display);
        expect(entries).toHaveLength(oracle.tailEntries.length);
        expect([...entries]).toEqual(oracle.tailEntries);
        expect(messages).toHaveLength(oracle.tailMessages.length);
        expect([...messages].map(({ id, text }) => ({ id, text })))
          .toEqual(oracle.tailMessages.map(({ id, text }) => ({ id, text })));
      }
    }
  }));
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

it("does not replay earlier reviews after seeing unrelated legacy text without a turn", () => {
  fc.assert(fc.property(fc.integer({ min: 10, max: 60 }), (size) => {
    let visits = 0;
    const oldReviews: AppServerThreadEntry[] = Array.from({ length: size }, (_, row) => ({
      id: `old-${row}`, get type() { visits++; return "review" as const; },
      review: `Old findings ${row}`, turn: { id: `old-turn-${row}` },
    }));
    const oldAnswer = { ...assistant("legacy", "Earlier ordinary answer.", "ignored"), turn: undefined };
    const index = createTranscriptHistoryIndex();
    let history = prependTranscriptHistoryPage({
      history: undefined, index, page: replay([oldAnswer, ...oldReviews]), tailEntries: [],
    });
    createTranscriptReviewPresentation({ history, index, tailEntries: [], tailMessages: [] });
    visits = 0;
    for (let step = 0; step < 4; step++) {
      const review: AppServerThreadEntry = {
        id: `new-review-${step}`, type: "review", review: "No issues.", turn: { id: `new-turn-${step}` },
      };
      const tail = [review];
      expect(createTranscriptReviewPresentation({ history, index, tailEntries: tail, tailMessages: [] }).tailEntries)
        .toEqual(tail);
      history = appendTranscriptHistoryPage({ history, index, page: replay(tail), tailEntries: [] });
    }
    expect(visits).toBe(0);
  }));
});

it("agrees with a full replay when new pages actually share legacy review text", () => {
  fc.assert(fc.property(fc.boolean(), fc.array(fc.constantFrom("Earlier answer.", "No issues.", "Other text."), {
    minLength: 2, maxLength: 15,
  }), (legacyReview, texts) => {
    const raw: AppServerThreadEntry[] = [
      { ...assistant("legacy-answer", "Earlier answer.", "ignored"), turn: undefined },
      { id: "previous-review", type: "review", review: "No issues.",
        ...(legacyReview ? {} : { turn: { id: "previous-turn" } }) },
    ];
    const index = createTranscriptHistoryIndex();
    let history = prependTranscriptHistoryPage({ history: undefined, index, page: replay(raw), tailEntries: [] });
    for (const [step, text] of texts.entries()) {
      const turnId = `new-turn-${step}`;
      const advanced: AppServerThreadEntry[] = [
        assistant(`reply-${step}`, text, turnId),
        { id: `review-${step}`, type: "review", review: texts.at(-1)!, turn: { id: turnId } },
      ];
      const displayed = createTranscriptReviewPresentation({
        history, index, tailEntries: advanced, tailMessages: replay(advanced).replay.messages,
      });
      raw.push(...advanced);
      const expected = deriveTranscriptReviewPresentation({
        historyEvents: [], historyIndex: createTranscriptReviewHistoryIndex(), tailEntries: raw, tailMessages: replay(raw).replay.messages,
      });
      expect([...combineTranscriptEntries(history, index, displayed.tailEntries, displayed)]).toEqual(expected.tailEntries);
      history = appendTranscriptHistoryPage({ history, index, page: replay(advanced), tailEntries: [] });
    }
  }));
});

it("hides split-turn native Codex review prompts across any page split and order while preserving authored, sourced, and steer messages", () => {
  const branchPrompt =
    "Review the code changes against the base branch 'origin/main'. Run git diff abc123 to inspect the changes relative to origin/main. Provide prioritized, actionable findings.";
  fc.assert(fc.property(
    fc.constantFrom("branch" as const, "pullRequest" as const),
    fc.boolean(),
    fc.boolean(),
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 0, max: 5 }),
    (target, splitTurn, promptBeforeReview, splitA, splitB) => {
      const text = target === "pullRequest" ? pullRequestReviewPrompt : branchPrompt;
      const outerTurnId = "outer-review-turn";
      const promptTurn = splitTurn
        ? { id: "inner-review-turn", rootTurnId: outerTurnId, status: "interrupted" as const }
        : { id: outerTurnId, status: "completed" as const };
      const reviewTurn = { id: outerTurnId, rootTurnId: outerTurnId, status: "completed" as const };
      const generated: AppServerThreadMessageEntry = {
        type: "message", id: "generated", role: "user", text, turn: promptTurn,
      };
      const authored: AppServerThreadMessageEntry = {
        type: "message", id: "authored", role: "user", text,
        turn: { id: "ordinary-turn", rootTurnId: "ordinary-turn", status: "completed" },
      };
      const sourced: AppServerThreadMessageEntry = {
        type: "message", id: "sourced", role: "user", text, origin: { kind: "messaging" }, turn: promptTurn,
      };
      const steer: AppServerThreadMessageEntry = {
        type: "message", id: "steer", role: "user",
        text: "Review these code changes for security and provide prioritized findings.",
        turn: promptTurn,
      };
      const review: AppServerThreadEntry = {
        type: "review", id: "review", review: "No findings.", turn: reviewTurn,
      };
      const all = promptBeforeReview
        ? [authored, generated, sourced, steer, review]
        : [authored, review, generated, sourced, steer];
      const cut1 = Math.min(splitA, splitB, all.length);
      const cut2 = Math.min(Math.max(splitA, splitB), all.length);
      const page1 = all.slice(0, cut1);
      const page2 = all.slice(cut1, cut2);
      const tailEntries = all.slice(cut2);
      const index = createTranscriptHistoryIndex();
      let history: ReturnType<typeof appendTranscriptHistoryPage> | undefined;
      for (const page of [page1, page2]) {
        if (page.length === 0) continue;
        history = appendTranscriptHistoryPage({ history, index, page: replay(page), tailEntries: [] });
      }
      const presentation = createTranscriptReviewPresentation({
        history, index, tailEntries, tailMessages: replay(tailEntries).replay.messages,
      });
      const visibleEntries = [...combineTranscriptEntries(history, index, presentation.tailEntries, presentation)];
      const visibleMessages = [...combineTranscriptMessages(history, index, presentation.tailMessages, presentation)];
      expect(visibleEntries.map((entry) => entry.id)).toEqual(
        all.filter((entry) => entry.id !== "generated").map((entry) => entry.id),
      );
      expect(visibleMessages.map((message) => message.id)).toEqual(
        replay(all).replay.messages.filter((message) => message.id !== "generated").map((message) => message.id),
      );
    },
  ));
});
