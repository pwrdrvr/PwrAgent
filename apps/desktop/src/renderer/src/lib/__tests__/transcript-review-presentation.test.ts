import type { AppServerThreadEntry, AppServerThreadMessageEntry } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { pullRequestReviewPrompt } from "../../../../shared/__tests__/fixtures/pull-request-review";
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

  it.each([
    [true, "branch"], [false, "branch"], [true, "pullRequest"], [false, "pullRequest"],
  ] as const)("correlates prompts and markers across history pages (prompt in history: %s, target: %s)", (promptInHistory, target) => {
    const text = target === "pullRequest" ? pullRequestReviewPrompt
      : "Review the code changes against the base branch 'origin/main'. Run git diff abc123 to inspect the changes relative to origin/main. Provide prioritized, actionable findings.";
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
