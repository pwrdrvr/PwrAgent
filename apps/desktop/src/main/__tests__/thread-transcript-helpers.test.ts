import { describe, expect, it } from "vitest";
import type {
  AppServerThreadReplay,
  AppServerThreadReviewEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { mergeManagedReviewEntries } from "../app-server/thread-transcript-helpers";

describe("mergeManagedReviewEntries", () => {
  it("does not splice a foreign review into the middle of an existing provider turn", () => {
    const replay: AppServerThreadReplay = {
      entries: [
        {
          type: "message",
          id: "prov-0",
          role: "user",
          text: "first",
          createdAt: 0,
          turn: { id: "turn-0", status: "completed" },
        },
        {
          type: "message",
          id: "prov-1",
          role: "assistant",
          text: "reply",
          createdAt: 1,
          turn: { id: "turn-0", status: "completed" },
        },
      ],
      messages: [],
      pagination: { supportsPagination: false, hasPreviousPage: false },
      threadStatus: "idle",
    };
    const reviewEntries: AppServerThreadReviewEntry[] = [
      {
        type: "review",
        id: "managed-review:review-turn-0:started",
        review: "Review changes",
        displayText: "Review changes",
        createdAt: 0,
        turn: { id: "review-turn-0", status: "completed" },
      },
      {
        type: "review",
        id: "managed-review:review-turn-0:result",
        review: "Findings",
        turn: { id: "review-turn-0", status: "completed" },
      },
    ];

    const merged = mergeManagedReviewEntries({ replay, entries: reviewEntries });
    expect(merged.entries.map((entry) => entry.id)).toEqual([
      "prov-0",
      "prov-1",
      "managed-review:review-turn-0:started",
      "managed-review:review-turn-0:result",
    ]);
  });
});
