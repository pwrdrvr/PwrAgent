import { describe, expect, it } from "vitest";
import type {
  AppServerThreadEntry,
  AppServerThreadReplay,
  AppServerThreadReviewEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  inferLegacyTaskMonitorMessageOrigins,
  insertTranscriptEntry,
  mergeManagedReviewEntries,
} from "../app-server/thread-transcript-helpers";

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

  it("matches sequential insertTranscriptEntry on empty base, out-of-order timestamps, and duplicate review ids", () => {
    const emptyBaseReviews: AppServerThreadReviewEntry[] = [
      {
        type: "review",
        id: "rev-2",
        review: "Later",
        displayText: "Later",
        createdAt: 901,
      },
      {
        type: "review",
        id: "rev-0",
        review: "Earlier",
        displayText: "Earlier",
        createdAt: 900,
      },
      {
        type: "review",
        id: "rev-1",
        review: "Untimed",
        displayText: "Untimed",
      },
    ];
    const emptyReplay: AppServerThreadReplay = {
      entries: [],
      messages: [],
      pagination: { supportsPagination: false, hasPreviousPage: false },
      threadStatus: "idle",
    };
    let expectedEmpty: AppServerThreadEntry[] = emptyReplay.entries;
    for (const review of emptyBaseReviews) {
      expectedEmpty = insertTranscriptEntry(
        expectedEmpty.filter((entry) => entry.id !== review.id),
        review,
      );
    }
    expect(
      mergeManagedReviewEntries({ replay: emptyReplay, entries: emptyBaseReviews }).entries,
    ).toEqual(expectedEmpty);

    const existingReplay: AppServerThreadReplay = {
      entries: [
        {
          type: "message",
          id: "prov-0",
          role: "user",
          text: "first",
          createdAt: 1_000,
          turn: { id: "turn-0", status: "completed" },
        },
        {
          type: "review",
          id: "rev-a",
          review: "Stale copy",
          displayText: "Stale copy",
          createdAt: 1_050,
          turn: { id: "review-turn-a", status: "completed" },
        },
        {
          type: "message",
          id: "prov-1",
          role: "assistant",
          text: "second",
          createdAt: 2_000,
          turn: { id: "turn-1", status: "completed" },
        },
      ],
      messages: [],
      pagination: { supportsPagination: false, hasPreviousPage: false },
      threadStatus: "idle",
    };
    const duplicateReviews: AppServerThreadReviewEntry[] = [
      {
        type: "review",
        id: "rev-b",
        review: "Follow-up on stale turn",
        displayText: "Follow-up on stale turn",
        createdAt: 2_500,
        turn: { id: "review-turn-a", status: "completed" },
      },
      {
        type: "review",
        id: "rev-a",
        review: "Updated copy",
        displayText: "Updated copy",
        createdAt: 3_000,
        turn: { id: "review-turn-b", status: "completed" },
      },
    ];
    let expectedExisting: AppServerThreadEntry[] = existingReplay.entries;
    for (const review of duplicateReviews) {
      expectedExisting = insertTranscriptEntry(
        expectedExisting.filter((entry) => entry.id !== review.id),
        review,
      );
    }
    expect(
      mergeManagedReviewEntries({ replay: existingReplay, entries: duplicateReviews }).entries,
    ).toEqual(expectedExisting);
  });

  it("keeps base entry reads linear and independent of managed review count", () => {
    const measureBaseReads = (reviewCount: number): number => {
      let reads = 0;
      const baseEntries: AppServerThreadEntry[] = Array.from({ length: 120 }, (_v, index) =>
        new Proxy<AppServerThreadEntry>(
          {
            type: "message",
            id: `e-${index}`,
            role: index % 2 === 0 ? "user" : "assistant",
            text: `msg ${index}`,
            createdAt: 10_000 + index * 100,
            turn: { id: `turn-${Math.floor(index / 4)}`, status: "completed" },
          },
          {
            get(target, property, receiver) {
              if (property === "id" || property === "turn" || property === "createdAt") {
                reads += 1;
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
      );
      const reviews: AppServerThreadReviewEntry[] = Array.from({ length: reviewCount }, (_v, i) => ({
        type: "review",
        id: `rev-${i}`,
        review: `Review ${i}`,
        displayText: `Review ${i}`,
        createdAt: 10_000 + Math.floor((i * 120) / reviewCount) * 100 + 50,
        turn: { id: `review-turn-${i}`, status: "completed" },
      }));
      mergeManagedReviewEntries({
        replay: {
          entries: baseEntries,
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
          threadStatus: "idle",
        },
        entries: reviews,
      });
      return reads;
    };

    const withFiveReviews = measureBaseReads(5);
    const withFortyReviews = measureBaseReads(40);
    expect(withFortyReviews).toBe(withFiveReviews);
    expect(withFortyReviews).toBeLessThanOrEqual(120 * 4);
  });
});

describe("inferLegacyTaskMonitorMessageOrigins", () => {
  it("stays linear in user message count", () => {
    const measureIdReads = (userCount: number): number => {
      let idReads = 0;
      const entries: AppServerThreadEntry[] = Array.from({ length: userCount }, (_v, index) =>
        new Proxy<AppServerThreadEntry>(
          {
            type: "message",
            id: `user-${index}`,
            role: "user",
            text: index === 0
              ? "A lightweight PwrAgent monitor subagent finished a long-running task.\nTask: Wait for CI\nOutcome: success\nCI passed"
              : `Normal prompt ${index}`,
            createdAt: 1_000 + index,
          },
          {
            get(target, property, receiver) {
              if (property === "id") {
                idReads += 1;
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
      );
      inferLegacyTaskMonitorMessageOrigins({
        origins: {},
        replay: {
          entries,
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
          threadStatus: "idle",
        },
        subAgents: [
          {
            monitorId: "monitor-1",
            task: "Wait for CI",
            status: "success",
            createdAt: 900,
            updatedAt: 999,
            completedAt: 999,
            lastMessage: "CI passed",
          },
        ],
      });
      return idReads;
    };

    const smallReads = measureIdReads(50);
    const largeReads = measureIdReads(150);
    expect(smallReads).toBeGreaterThan(0);
    // An O(U^2) findIndex dedup grows 9x for 3x user messages.
    expect(largeReads).toBeLessThanOrEqual(smallReads * 4);
  });
});
