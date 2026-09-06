import { describe, expect, it, vi } from "vitest";
import type { NavigationDirectorySummary, NavigationQueryPage } from "@pwragent/shared";

const mocks = vi.hoisted(() => ({ loadIndex: vi.fn() }));
vi.mock("../app-server/navigation-query-source", () => ({ loadLocalNavigationQueryIndex: mocks.loadIndex }));
import { readLocalNavigationDirectoryIndex } from "../app-server/navigation-directory-index";
import { getDesktopNavigationQueryStore } from "../app-server/navigation-query-store";

function page(patch: Partial<NavigationQueryPage>): NavigationQueryPage {
  return { protocol: 2, queryKey: "query", generation: "generation", ownerEpoch: "owner", countsRevision: "revision",
    counts: { total: 0, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, entries: [], complete: true, ...patch };
}

describe("owner-local compact directory reads", () => {
  it("coalesces concurrent owner consumers and completes every directory page through the shared pool", async () => {
    const directories: NavigationDirectorySummary[] = Array.from({ length: 101 }, (_, index) => ({
      key: `directory:${index}`, kind: "directory", label: `Project ${index}`, path: `/project/${index}`, threadKeys: [], needsAttentionCount: 0,
    }));
    mocks.loadIndex.mockResolvedValue({ directories, threads: [] });
    const [first, second] = await Promise.all([readLocalNavigationDirectoryIndex(), readLocalNavigationDirectoryIndex()]);
    expect(first).toHaveLength(101);
    expect(second).toEqual(first);
    expect(mocks.loadIndex).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("threadKeys");
    expect(JSON.stringify(first)).not.toContain("launchpadDefaults");
  });

  it("rejects mixed generations without returning a partial directory population", async () => {
    const read = vi.spyOn(getDesktopNavigationQueryStore(), "readPage")
      .mockResolvedValueOnce(page({ complete: false, nextCursor: "next", directories: [] }))
      .mockResolvedValueOnce(page({ generation: "other", directories: [] }));
    try {
      await expect(readLocalNavigationDirectoryIndex()).rejects.toThrow("complete matching owner generation");
      expect(read).toHaveBeenCalledTimes(2);
    } finally { read.mockRestore(); }
  });
});
