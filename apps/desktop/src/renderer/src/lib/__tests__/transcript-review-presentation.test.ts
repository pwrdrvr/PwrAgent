import type {
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { describe, expect, it } from "vitest";
import { pullRequestReviewPrompt } from "../../../../shared/__tests__/fixtures/pull-request-review";
import {
  addTranscriptReviewSegmentToIndex,
  createTranscriptReviewHistoryIndex,
  deriveTranscriptReviewPresentation,
  iterateTranscriptReviewHistoryEvents,
  presentIndexedTranscriptReviews,
  summarizeTranscriptReviewSegment,
} from "../transcript-review-presentation";

describe("native review prompt presentation", () => {
  it.each(["history", "tail"] as const)("keeps a legacy reply that matches a receipt-bound placeholder in the %s", (placement) => {
    const text = "Review changes against main";
    const earlier: AppServerThreadMessageEntry = { type: "message", id: "earlier", role: "assistant", text };
    const placeholder: AppServerThreadEntry = {
      type: "review", id: "optimistic-review-start", review: text, displayText: text,
      turn: { id: "accepted-review" },
    };
    const index = createTranscriptReviewHistoryIndex();
    addTranscriptReviewSegmentToIndex(index, summarizeTranscriptReviewSegment(
      placement === "history" ? [earlier, placeholder] : [earlier],
      [earlier],
    ));
    const result = deriveTranscriptReviewPresentation({
      historyEvents: iterateTranscriptReviewHistoryEvents(index), historyIndex: index,
      tailEntries: placement === "tail" ? [placeholder] : [],
      tailMessages: [],
    });
    // Receipt binding cannot hide an existing answer with the same text.
    expect([...result.excludedHistoryEntryIds]).toEqual([]);
    expect([...result.excludedHistoryMessageIds]).toEqual([]);
    expect(result.tailEntries).toEqual(placement === "tail" ? [placeholder] : []);
  });

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

  it.each([
    ["same-tail", "pullRequest"],
    ["prompt-in-history", "pullRequest"],
    ["review-in-history", "pullRequest"],
    ["split-history-pages", "branch"],
  ] as const)("suppresses split-turn Codex review prompts via rootTurnId (%s, %s)", (placement, target) => {
    const text = target === "pullRequest"
      ? pullRequestReviewPrompt
      : "Review the code changes against the base branch 'origin/main'. Run git diff abc123 to inspect the changes relative to origin/main. Provide prioritized, actionable findings.";
    const prompt: AppServerThreadMessageEntry = {
      type: "message",
      id: "prompt",
      role: "user",
      text,
      turn: { id: "inner-review-turn", rootTurnId: "outer-review-turn", status: "interrupted" },
    };
    const authored: AppServerThreadMessageEntry = {
      ...prompt,
      id: "authored",
      turn: { id: "ordinary-turn", rootTurnId: "ordinary-turn", status: "completed" },
    };
    const review: AppServerThreadEntry = {
      type: "review",
      id: "review",
      review: "No findings.",
      turn: { id: "outer-review-turn", rootTurnId: "outer-review-turn", status: "completed" },
    };

    const index = createTranscriptReviewHistoryIndex();
    const historyEntryIds = new Set<string>();
    const historyMessageIds = new Set<string>();
    const historyTurns = new Map<string, true>();
    const addPage = (page: AppServerThreadEntry[]) => {
      const pageMessages = page.filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message");
      addTranscriptReviewSegmentToIndex(index, summarizeTranscriptReviewSegment(page, pageMessages), "newer", true);
      for (const entry of page) {
        historyEntryIds.add(entry.id);
        if (entry.turn?.id) historyTurns.set(entry.turn.id, true);
      }
      for (const message of pageMessages) historyMessageIds.add(message.id);
    };

    let tailEntries: AppServerThreadEntry[] = [];
    if (placement === "same-tail") {
      tailEntries = [authored, prompt, review];
    } else if (placement === "prompt-in-history") {
      addPage([authored, prompt]);
      tailEntries = [review];
    } else if (placement === "review-in-history") {
      addPage([authored, review]);
      tailEntries = [prompt];
    } else {
      addPage([authored, prompt]);
      addPage([review]);
      tailEntries = [];
    }
    const tailMessages = tailEntries.filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message");
    const result = presentIndexedTranscriptReviews({
      index,
      historyEntryIds,
      historyMessageIds,
      historyTurns,
      tailEntries,
      tailMessages,
    });

    if (placement === "same-tail") {
      expect(result.tailEntries.map((entry) => entry.id)).toEqual(["authored", "review"]);
      expect(result.tailMessages.map((message) => message.id)).toEqual(["authored"]);
    } else if (placement === "prompt-in-history") {
      expect([...result.excludedHistoryEntryIds]).toEqual(["prompt"]);
      expect([...result.excludedHistoryMessageIds]).toEqual(["prompt"]);
      expect(result.tailEntries.map((entry) => entry.id)).toEqual(["review"]);
    } else if (placement === "review-in-history") {
      expect(result.tailEntries.map((entry) => entry.id)).toEqual([]);
      expect(result.tailMessages.map((message) => message.id)).toEqual([]);
    } else {
      expect([...result.excludedHistoryEntryIds]).toEqual(["prompt"]);
      expect([...result.excludedHistoryMessageIds]).toEqual(["prompt"]);
    }
  });
});
