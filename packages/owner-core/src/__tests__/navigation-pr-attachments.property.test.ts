import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { projectNavigationQuery } from "../navigation-query-projection";

describe("navigation PR attachment previews", () => {
  it("keeps a compact preview, reports the full count, and surfaces the only open PR", () => {
    fc.assert(fc.property(
      fc.integer({ min: 17, max: 128 }),
      fc.nat(),
      (count, position) => {
        const openIndex = 16 + position % (count - 16);
        const prs: PrSummary[] = Array.from({ length: count }, (_, index) => ({
          provider: "github.com",
          org: "fixture",
          repo: "repo",
          number: index + 1,
          url: `https://github.com/fixture/repo/pull/${index + 1}`,
          state: index === openIndex ? "passing" : "closed",
        }));
        const thread: NavigationThreadSummary = {
          id: "thread", source: "codex", title: "Thread", titleSource: "derived",
          linkedDirectories: [], inbox: { inInbox: false }, prs,
        };
        const result = projectNavigationQuery({
          index: { threads: [thread], directories: [] },
          request: {
            protocol: 2, consumer: "main-sidebar",
            query: { kind: "exact", identities: [{ backend: "codex", threadId: thread.id }] },
          },
        });
        const row = result.entries[0]?.row;
        expect(row?.prs).toContain(prs[openIndex]);
        expect(row?.prs).toHaveLength(16);
        expect(row?.prsTruncated).toBe(true);
        expect(row?.prCount).toBe(count);
      },
    ));
  });
});
