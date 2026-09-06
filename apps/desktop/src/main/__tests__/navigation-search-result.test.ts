import { describe, expect, it } from "vitest";
import { rankThreadJumpMatches, type NavigationThreadSummary } from "@pwragent/shared";
import { compactNavigationSearchResult } from "../federation/navigation-search-result";
import { federationTransportCodecForTest } from "../federation/federation-transport";

describe("compact navigation search results", () => {
  it("keeps eight bloated matches below 64 KiB without shipping thread state", () => {
    const huge = "x".repeat(1_000_000);
    const thread: NavigationThreadSummary = {
      id: "thread", source: "codex", title: "PR 1968", titleSource: "explicit",
      linkedDirectories: [{ id: "dir", label: "repo", path: "/repo", kind: "local" }],
      inbox: { inInbox: true }, summary: huge,
      optimisticUserMessage: { text: huge },
      agent: { name: "Agent", instructions: huge, instructionLineCount: 1, instructionsTooLong: true, updatedAt: 0 },
      prs: [{ provider: "github.com", org: "org", repo: "repo", number: 1968,
        url: "https://github.com/org/repo/pull/1968", state: "passing", commitShas: Array(10000).fill(huge.slice(0, 40)) }],
    };
    const results = Array.from({ length: 8 }, (_, index) => compactNavigationSearchResult({ ...thread, id: `thread-${index}` }, "1968"));
    const wire = federationTransportCodecForTest.encodeEnvelope({
      kind: "response", id: "response", requestId: "search", protocolVersion: 1,
      sourceInstanceId: "owner", targetInstanceId: "viewer", createdAt: 0,
      result: { results },
    });
    expect(wire.byteLength).toBeLessThan(64 * 1024);
    expect(results[0]).toMatchObject({ id: "thread-0", linkedDirectories: [{ path: "/repo" }], prs: [{ number: 1968, url: thread.prs![0].url }] });
    expect(results[0]).not.toHaveProperty("optimisticUserMessage");
    expect(results[0]).not.toHaveProperty("summary");
    expect(results[0].prs![0]).not.toHaveProperty("commitShas");
    expect(thread.optimisticUserMessage!.text).toHaveLength(1_000_000);
  });

  it("preserves matches for old viewers even when evidence is deep in large fields", () => {
    const thread: NavigationThreadSummary = {
      id: "thread", source: "codex", title: "Agent", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false },
      agent: { name: "Agent", instructions: `${"x".repeat(10000)} needle ${"y".repeat(10000)} haystack`, instructionLineCount: 1, instructionsTooLong: true, updatedAt: 0 },
    };
    const result = compactNavigationSearchResult(thread, "needle haystack");
    expect(rankThreadJumpMatches([result], "needle haystack")).toHaveLength(1);
    expect(result.agent!.instructions!.length).toBeLessThan(2048);
  });
});
