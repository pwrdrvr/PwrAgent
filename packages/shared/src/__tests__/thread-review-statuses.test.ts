import { describe, expect, it } from "vitest";
import {
  THREAD_REVIEW_ITEM_STATUSES,
  normalizeThreadReview,
  normalizeThreadReviewItemStatus,
  type ThreadReview,
} from "../contracts/thread-reviews";

const item = (id: string, status: string) => ({ id, title: id, status, createdAt: 1, updatedAt: 1 });

describe("finding status names", () => {
  it("keeps each current name and maps the older ones", () => {
    for (const status of THREAD_REVIEW_ITEM_STATUSES) expect(normalizeThreadReviewItemStatus(status)).toBe(status);
    expect(normalizeThreadReviewItemStatus("dismissed")).toBe("declined");
    expect(normalizeThreadReviewItemStatus("fixed")).toBe("addressed");
    // Claude Code counts both as settled: "real but not applied", and wrong.
    expect(normalizeThreadReviewItemStatus("skipped")).toBe("declined");
    expect(normalizeThreadReviewItemStatus("no_change_needed")).toBe("declined");
  });

  it("names nothing for a review's statuses or a non-string", () => {
    for (const value of ["handled", "toString", "", undefined, 1]) {
      expect(normalizeThreadReviewItemStatus(value)).toBeUndefined();
    }
  });

  it("renames an older record's findings and returns a current one as it is", () => {
    const current = { items: [item("a", "declined"), item("b", "deferred")] } as unknown as ThreadReview;
    expect(normalizeThreadReview(current)).toBe(current);
    const older = { status: "dismissed", items: [item("a", "dismissed"), item("b", "open")] } as unknown as ThreadReview;
    const renamed = normalizeThreadReview(older);
    expect(renamed).not.toBe(older);
    expect(renamed.items.map((entry) => entry.status)).toEqual(["declined", "open"]);
    expect(renamed.items[1]).toBe(older.items[1]);
    // The review's own dismissal keeps its name.
    expect(renamed.status).toBe("dismissed");
    expect(older.items[0]!.status).toBe("dismissed");
  });
});
