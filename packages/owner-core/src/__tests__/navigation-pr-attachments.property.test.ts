import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildPullRequestStatusKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { projectNavigationQuery } from "../navigation-query-projection";

function preview(prs: PrSummary[], stackLeadPrKey?: string) {
  const thread: NavigationThreadSummary = {
    id: "thread", source: "codex", title: "Thread", titleSource: "derived",
    linkedDirectories: [], inbox: { inInbox: false }, prs, stackLeadPrKey,
  };
  return projectNavigationQuery({
    index: { threads: [thread], directories: [] },
    request: {
      protocol: 2, consumer: "main-sidebar",
      query: { kind: "exact", identities: [{ backend: "codex", threadId: thread.id }] },
    },
  }).entries[0]?.row;
}

function pullRequest(index: number, state: PrSummary["state"]): PrSummary {
  return {
    provider: "github.com", org: "fixture", repo: "repo", number: index + 1,
    url: `https://github.com/fixture/repo/pull/${index + 1}`, state,
  };
}

describe("navigation PR attachment previews", () => {
  it("keeps a compact preview, reports the full count, and surfaces the only open PR", () => {
    fc.assert(fc.property(
      fc.integer({ min: 17, max: 128 }),
      fc.nat(),
      (count, position) => {
        const openIndex = 16 + position % (count - 16);
        const prs = Array.from({ length: count }, (_, index) =>
          pullRequest(index, index === openIndex ? "passing" : "closed"));
        const row = preview(prs);
        expect(row?.prs).toContain(prs[openIndex]);
        expect(row?.prs).toHaveLength(16);
        expect(row?.prsTruncated).toBe(true);
        expect(row?.prCount).toBe(count);
      },
    ));
  });

  it("preserves an older owner-selected stack lead within the bounded attachment preview", () => {
    fc.assert(fc.property(fc.integer({ min: 20, max: 128 }), (count) => {
      const prs = Array.from({ length: count }, (_, index) => ({
        ...pullRequest(index, index === 0 ? "passing" : "failing"),
        createdAt: index + 1,
      }));
      const lead = prs[0]!;
      const leadKey = buildPullRequestStatusKey(lead);
      const row = preview(prs, leadKey);
      expect(row?.stackLeadPrKey).toBe(leadKey);
      expect(row?.prs).toHaveLength(16);
      expect(row?.prs).toContain(lead);
    }));
  });

  it("retains the lead, the least-ready PR, and the least-ready PR behind the lead", () => {
    fc.assert(fc.property(fc.integer({ min: 18, max: 128 }), fc.boolean(), (count, leadHasConflict) => {
      const prs = Array.from({ length: count }, (_, index) => pullRequest(index, "passing"));
      // Provider time determines the lead, independently of attachment order.
      const lead: PrSummary = {
        ...prs[0]!, createdAt: 300, mergeState: leadHasConflict ? "conflicting" : "mergeable",
      };
      const blocked: PrSummary = {
        ...prs[1]!, state: "failing", mergeState: leadHasConflict ? "mergeable" : "conflicting", createdAt: 100,
      };
      prs[0] = lead;
      prs[1] = blocked;
      for (let index = 2; index < count; index += 1) prs[index] = { ...prs[index]!, createdAt: 200 };
      const compact = preview(prs)?.prs;
      expect(compact).toEqual(expect.arrayContaining([lead, blocked]));
      expect(compact).toHaveLength(16);
    }));
  });
});
