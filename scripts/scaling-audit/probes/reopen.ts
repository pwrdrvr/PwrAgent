import { record } from "./scaling-audit-results";
import { it } from "vitest";
import type {
  AppServerThreadEntry,
  AppServerThreadReviewEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  inferLegacyTaskMonitorMessageOrigins,
  mergeManagedReviewEntries,
} from "../app-server/thread-transcript-helpers";

it("counts base entry reads by inventory and managed review count", () => {
  const measureBaseReads = (reviewCount: number, n:number): number => {
    let reads = 0;
    const baseEntries: AppServerThreadEntry[] = Array.from({ length: n }, (_v, index) =>
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
      createdAt: 10_000 + Math.floor((i * n) / reviewCount) * 100 + 50,
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

  for (const n of [60, 120, 240]) {
    for (const reviews of [3, 6, 12, 24]) {
      record({ kind: "review-merge", n, reviews, reads: measureBaseReads(reviews, n) });
    }
  }
});
it("counts message ID reads during legacy monitor attribution", () => {
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

  for (const n of [50, 100, 200, 400]) record({ kind: "reopen-monitor", n, reads: measureIdReads(n) });
});
