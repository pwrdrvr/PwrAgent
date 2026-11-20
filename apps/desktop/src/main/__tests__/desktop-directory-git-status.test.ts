import type { NavigationDirectoryGitStatus } from "@pwragent/shared/contracts/navigation";
import { expect, it, vi } from "vitest";
import { DesktopDirectoryGitStatus } from "../app-server/desktop-directory-git-status";
import type { DirectoryGitStatusCacheEntry } from "../storage/desktop-overlay-store";

const directory = {
  key: "fixture", kind: "directory" as const, label: "Fixture",
  path: "/fixture/example", latestUpdatedAt: 11, threadKeys: [], needsAttentionCount: 0,
};
const gitStatus: NavigationDirectoryGitStatus = { currentBranch: "feature/fixture" };

it("coalesces a directory's refresh and publishes only after writing its cache entry", async () => {
  const probe = Promise.withResolvers<void>();
  const published = Promise.withResolvers<DirectoryGitStatusCacheEntry | undefined>();
  const persisted = new Map<string, DirectoryGitStatusCacheEntry>();
  const read = vi.fn(async function* () {
    await probe.promise;
    yield { directoryKey: directory.key, gitStatus };
  });
  const publishLocalEvent = vi.fn(async () => {
    published.resolve(persisted.get(directory.key));
  });
  const owner = new DesktopDirectoryGitStatus({
    getOverlayStore: () => ({
      readDirectoryGitStatusCache: async () => Object.fromEntries(persisted),
      writeDirectoryGitStatusCacheEntry: async (entry) => { persisted.set(entry.directoryKey, entry); },
    }),
    getNavigationQueryPage: async () => { throw new Error("No navigation page expected"); },
    releaseNavigationPage: () => {},
    findDirectory: () => directory,
    readDirectoryStatusEntries: read,
    publishLocalEvent,
    logDebug: () => {},
  });
  try {
    const refresh = { automatic: false, directories: [directory], force: true };
    expect(owner.startDirectoryGitStatusRefresh({ ...refresh, requestKey: "first" })).toBe(1);
    expect(owner.startDirectoryGitStatusRefresh({ ...refresh, requestKey: "second" })).toBe(0);
    probe.resolve();
    expect((await published.promise)?.gitStatus).toEqual(gitStatus);
    expect(owner.applyCachedStatus(directory).gitStatus).toEqual(gitStatus);
    expect(read).toHaveBeenCalledTimes(1);
    expect(publishLocalEvent).toHaveBeenCalledWith(expect.objectContaining({
      notification: expect.objectContaining({ method: "navigation/directoryGitStatus/updated" }),
    }));

    const freshAt = Date.now() + 1;
    await owner.writeDirectoryGitStatusEntry({ directoryKey: directory.key, gitStatus, fetchedAt: freshAt });
    expect(persisted.get(directory.key)).toMatchObject({ directoryPath: directory.path, directoryUpdatedAt: 11, fetchedAt: freshAt });
    expect(publishLocalEvent).toHaveBeenCalledTimes(1);
  } finally {
    probe.resolve();
  }
});
