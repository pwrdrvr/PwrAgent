import { describe, expect, it } from "vitest";
import { rankInboxThreadIds } from "../domain/inbox";

describe("rankInboxThreadIds", () => {
  it("ranks new threads ahead of updated threads and sorts by recency within each bucket", () => {
    const ranked = rankInboxThreadIds([
      {
        id: "updated-old",
        inbox: { inInbox: true, reason: "updated-since-seen" },
        updatedAt: 1000,
      },
      {
        id: "new-thread",
        inbox: { inInbox: true, reason: "new-thread" },
        updatedAt: 500,
      },
      {
        id: "updated-newer",
        inbox: { inInbox: true, reason: "updated-since-seen" },
        updatedAt: 2000,
      },
    ]);

    expect(ranked).toEqual(["new-thread", "updated-newer", "updated-old"]);
  });
});
