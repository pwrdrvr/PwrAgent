import { describe, expect, it } from "vitest";
import { rankInboxThreadKeys } from "../domain/inbox";

describe("rankInboxThreadKeys", () => {
  it("ranks new threads ahead of updated threads and sorts by recency within each bucket", () => {
    const ranked = rankInboxThreadKeys([
      {
        id: "updated-old",
        source: "codex",
        inbox: { inInbox: true, reason: "updated-since-seen" },
        updatedAt: 1000,
      },
      {
        id: "new-thread",
        source: "grok",
        inbox: { inInbox: true, reason: "new-thread" },
        updatedAt: 500,
      },
      {
        id: "updated-newer",
        source: "codex",
        inbox: { inInbox: true, reason: "updated-since-seen" },
        updatedAt: 2000,
      },
    ]);

    expect(ranked).toEqual([
      "grok:new-thread",
      "codex:updated-newer",
      "codex:updated-old",
    ]);
  });
});
