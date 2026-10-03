import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_APPROVAL_REVIEW_LOG_ENTRIES, type ThreadApprovalReview } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-approval-review-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function review(index: number): ThreadApprovalReview {
  return {
    id: `review-${index}`,
    kind: "invocation",
    action: index % 2 ? "decline" : "accept",
    subject: "Fixture / lookup",
    reason: `Reason ${index}`,
    turnId: "turn-1",
    occurredAt: 1_000 + index,
  };
}

describe("SqliteOverlayStore - approval review log", () => {
  it("persists decisions across sqlite handles and ignores a repeated id", async () => {
    await store.appendApprovalReview({ backend: "codex", threadId: "thread-1", review: review(1) });
    await store.appendApprovalReview({ backend: "codex", threadId: "thread-1", review: { ...review(1), reason: "Changed" } });
    stateDb.close();
    stateDb = StateDb.open(path.join(tempDir, "state.db"));
    store = new SqliteOverlayStore(stateDb);
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.approvalReviewLog).toEqual([review(1)]);
  });

  it("keeps only the newest decisions", async () => {
    for (let index = 0; index < MAX_APPROVAL_REVIEW_LOG_ENTRIES + 3; index += 1) {
      await store.appendApprovalReview({ backend: "codex", threadId: "thread-1", review: review(index) });
    }
    const log = (await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.approvalReviewLog ?? [];
    expect(log).toHaveLength(MAX_APPROVAL_REVIEW_LOG_ENTRIES);
    expect(log[0]?.id).toBe("review-3");
    expect(log.at(-1)?.id).toBe(`review-${MAX_APPROVAL_REVIEW_LOG_ENTRIES + 2}`);
  });
});
