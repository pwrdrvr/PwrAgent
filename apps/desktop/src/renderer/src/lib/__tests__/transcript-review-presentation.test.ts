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
    expect([...result.excludedHistoryEntryIds]).toEqual(promptInHistory ? ["prompt"] : []);
    expect([...result.excludedHistoryMessageIds]).toEqual(promptInHistory ? ["prompt"] : []);
    expect(result.tailEntries.map((entry) => entry.id)).toEqual(promptInHistory ? ["review"] : ["authored", "sourced", "steer"]);
    expect(result.tailMessages.map((entry) => entry.id)).toEqual(promptInHistory ? [] : ["authored", "sourced", "steer"]);
  });
});
