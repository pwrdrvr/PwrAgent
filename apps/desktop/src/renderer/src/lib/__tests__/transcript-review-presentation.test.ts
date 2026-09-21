import type { AppServerThreadEntry, AppServerThreadMessageEntry } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  addTranscriptReviewSegmentToIndex,
  createTranscriptReviewHistoryIndex,
  deriveTranscriptReviewPresentation,
  iterateTranscriptReviewHistoryEvents,
  summarizeTranscriptReviewSegment,
} from "../transcript-review-presentation";

describe("native review prompt presentation", () => {
  it("hides a complete inline envelope in history without native review markers", () => {
    const text = "<pwragent-inline-review-instructions>\nInspect this diff.\n</pwragent-inline-review-instructions>";
    const internal: AppServerThreadMessageEntry = { type: "message", id: "internal", role: "user", text };
    const entries: AppServerThreadMessageEntry[] = [
      internal,
      { ...internal, id: "surrounding", text: `Explain this: ${text}` },
      { ...internal, id: "incomplete", text: "<pwragent-inline-review-instructions>\nAn example" },
      { ...internal, id: "assistant", role: "assistant" },
    ];
    const index = createTranscriptReviewHistoryIndex();
    addTranscriptReviewSegmentToIndex(index, summarizeTranscriptReviewSegment(entries, entries));
    const result = deriveTranscriptReviewPresentation({
      historyEvents: iterateTranscriptReviewHistoryEvents(index), historyIndex: index,
      tailEntries: [], tailMessages: [],
    });
    expect([...result.excludedHistoryEntryIds]).toEqual(["internal"]);
    expect([...result.excludedHistoryMessageIds]).toEqual(["internal"]);
  });

  it.each([true, false])("correlates prompts and markers across history pages (prompt in history: %s)", (promptInHistory) => {
    const text = "Review the code changes against the base branch 'origin/main'. Run git diff abc123 to inspect the changes relative to origin/main. Provide prioritized, actionable findings.";
    const prompt: AppServerThreadMessageEntry = {
      type: "message", id: "prompt", role: "user", text,
      turn: { id: "native-review", status: "completed" },
    };
    const authored: AppServerThreadMessageEntry = {
      ...prompt, id: "authored", turn: { id: "ordinary-turn", status: "completed" },
    };
    const sourced: AppServerThreadMessageEntry = {
      ...prompt, id: "sourced", origin: { kind: "messaging" },
    };
    const steer: AppServerThreadMessageEntry = {
      ...prompt, id: "steer", text: "Review these code changes for security and provide prioritized findings.",
    };
    const review: AppServerThreadEntry = {
      type: "review", id: "review", review: "No findings.", turn: prompt.turn,
    };
    const historyEntries = promptInHistory ? [prompt, authored, sourced, steer] : [review];
    const tailEntries = promptInHistory ? [review] : [prompt, authored, sourced, steer];
    const historyMessages = historyEntries.filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message");
    const tailMessages = tailEntries.filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message");
    const index = createTranscriptReviewHistoryIndex();
    addTranscriptReviewSegmentToIndex(index, summarizeTranscriptReviewSegment(historyEntries, historyMessages));
    const result = deriveTranscriptReviewPresentation({
      historyEvents: iterateTranscriptReviewHistoryEvents(index), historyIndex: index,
      tailEntries, tailMessages,
    });
    expect([...result.excludedHistoryEntryIds]).toEqual(["prompt"]);
    expect([...result.excludedHistoryMessageIds]).toEqual(["prompt"]);
    expect(result.tailEntries.map((entry) => entry.id)).toEqual(promptInHistory ? ["review"] : ["authored", "sourced", "steer"]);
    expect(result.tailMessages.map((entry) => entry.id)).toEqual(promptInHistory ? [] : ["authored", "sourced", "steer"]);
  });
});

describe("inline review result presentation", () => {
  // Main builds an inline review's result card from the turn's last
  // assistant message verbatim. The card is the one copy the reader sees.
  it.each([
    ["a verdict alone", "Nothing blocking here. The patch is correct."],
    [
      "findings",
      "One regression. The patch is incorrect.\n\nReview comments:\n\n- [P1] Guard the empty list — /repo/src/list.ts:4-6\n  `items[0]` is read before the length check.",
    ],
  ])("shows the result card and drops the assistant message it repeats (%s)", (_label, reviewText) => {
    const turn = { id: "turn-inline", status: "completed" as const };
    const tailEntries: AppServerThreadEntry[] = [
      {
        type: "review",
        id: "inline-review:turn-inline:started",
        review: "Review changes against main",
        displayText: "Review changes against main",
        turn: { ...turn, status: "in_progress" },
      },
      {
        type: "message",
        id: "prompt",
        role: "user",
        text: "<pwragent-inline-review-instructions>\nInspect this diff.\n</pwragent-inline-review-instructions>",
        turn,
      },
      { type: "message", id: "final", role: "assistant", text: reviewText, turn },
      {
        type: "review",
        id: "inline-review:turn-inline:result",
        review: reviewText,
        turn,
      },
    ];
    const tailMessages = tailEntries.filter(
      (entry): entry is AppServerThreadMessageEntry => entry.type === "message",
    );
    const index = createTranscriptReviewHistoryIndex();
    const result = deriveTranscriptReviewPresentation({
      historyEvents: iterateTranscriptReviewHistoryEvents(index), historyIndex: index,
      tailEntries, tailMessages,
    });
    expect(result.tailEntries.map((entry) => entry.id)).toEqual([
      "inline-review:turn-inline:started",
      "inline-review:turn-inline:result",
    ]);
    expect(result.tailMessages).toEqual([]);
  });
});

describe("structured inline review reply presentation", () => {
  const output = {
    findings: [],
    overall_correctness: "patch is correct" as const,
    overall_explanation: "No regressions in the diff.",
    overall_confidence_score: 0.9,
  };
  const replyText = JSON.stringify(output);
  const turn = { id: "turn-inline", status: "completed" as const };
  const start: AppServerThreadEntry = {
    type: "review",
    id: "inline-review:turn-inline:started",
    review: "Review changes against main",
    displayText: "Review changes against main",
    turn: { ...turn, status: "in_progress" },
  };
  const result: AppServerThreadEntry = {
    type: "review",
    id: "inline-review:turn-inline:result",
    review: "No regressions in the diff.\n\nNo findings.",
    output,
    turn,
  };
  const reply: AppServerThreadMessageEntry = {
    type: "message", id: "reply", role: "assistant", text: replyText, turn,
  };
  const present = (tailEntries: AppServerThreadEntry[], activeTurnId?: string) => {
    const index = createTranscriptReviewHistoryIndex();
    return deriveTranscriptReviewPresentation({
      activeTurnId,
      historyEvents: iterateTranscriptReviewHistoryEvents(index),
      historyIndex: index,
      tailEntries,
      tailMessages: tailEntries.filter(
        (entry): entry is AppServerThreadMessageEntry => entry.type === "message",
      ),
    });
  };

  it("drops the JSON reply beside the structured card it produced", () => {
    const presentation = present([start, reply, result]);
    expect(presentation.tailEntries.map((entry) => entry.id)).toEqual([
      start.id,
      result.id,
    ]);
    expect(presentation.tailMessages).toEqual([]);
  });

  it("drops a retained history copy of the reply too", () => {
    const index = createTranscriptReviewHistoryIndex();
    addTranscriptReviewSegmentToIndex(
      index,
      summarizeTranscriptReviewSegment([start, reply], [reply]),
    );
    const presentation = deriveTranscriptReviewPresentation({
      historyEvents: iterateTranscriptReviewHistoryEvents(index),
      historyIndex: index,
      tailEntries: [result],
      tailMessages: [],
    });
    expect([...presentation.excludedHistoryEntryIds]).toContain("reply");
    expect([...presentation.excludedHistoryMessageIds]).toContain("reply");
  });

  it("holds the reply back while its review turn runs, before the card lands", () => {
    expect(present([start, reply], "turn-inline").tailEntries.map((entry) => entry.id))
      .toEqual([start.id]);
  });

  it("keeps the reply when the review turn ended without a card", () => {
    // A failed or cancelled review publishes no result; the reply is then the
    // only copy of what the reviewer said.
    expect(present([start, reply]).tailEntries.map((entry) => entry.id))
      .toEqual([start.id, reply.id]);
  });

  it("keeps review-shaped JSON in an ordinary turn", () => {
    const ordinary = { ...reply, turn: { id: "turn-ordinary", status: "completed" as const } };
    expect(present([ordinary], "turn-ordinary").tailEntries.map((entry) => entry.id))
      .toEqual(["reply"]);
  });
});
