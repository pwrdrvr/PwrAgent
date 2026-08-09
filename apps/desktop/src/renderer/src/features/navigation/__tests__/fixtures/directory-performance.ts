import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";

export type LargeDirectoryFixture = {
  directories: NavigationDirectorySummary[];
  threads: NavigationThreadSummary[];
  threadsByKey: Map<string, NavigationThreadSummary>;
};

/**
 * Reproduces the operator shape that exposed the renderer cost: a small number
 * of project headers, each backed by a three-digit thread population. Callers
 * choose whether each project has a pinned row so they can exercise both the
 * sticky "Directory threads" disclosure and the ordinary Show more cap.
 */
export function buildLargeDirectoryFixture(options: {
  directoryCount?: number;
  pinnedThreadsPerDirectory?: number;
  unpinnedThreadsPerDirectory?: number;
  directoryThreadsCollapsed?: boolean;
} = {}): LargeDirectoryFixture {
  const directoryCount = options.directoryCount ?? 1;
  const pinnedThreadsPerDirectory =
    options.pinnedThreadsPerDirectory ?? 1;
  const unpinnedThreadsPerDirectory =
    options.unpinnedThreadsPerDirectory ?? 107;
  const threads: NavigationThreadSummary[] = [];
  const directories: NavigationDirectorySummary[] = [];

  for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
    const directoryNumber = directoryIndex + 1;
    const directoryPath = `/fixture/project-${directoryNumber}`;
    const directoryThreads: NavigationThreadSummary[] = [];
    const totalThreads =
      pinnedThreadsPerDirectory + unpinnedThreadsPerDirectory;

    for (let threadIndex = 0; threadIndex < totalThreads; threadIndex += 1) {
      const threadNumber = threadIndex + 1;
      const pinned = threadIndex < pinnedThreadsPerDirectory;
      directoryThreads.push({
        id: `project-${directoryNumber}-thread-${threadNumber}`,
        title: pinned
          ? `Pinned project ${directoryNumber} thread ${threadNumber}`
          : `Project ${directoryNumber} thread ${threadNumber}`,
        titleSource: "explicit",
        source: "codex",
        executionMode: "default",
        updatedAt: 1_800_000_000_000 - threadIndex,
        linkedDirectories: [
          {
            id: directoryPath,
            kind: "local",
            label: `Project ${directoryNumber}`,
            path: directoryPath,
          },
        ],
        inbox: {
          inInbox: false,
        },
        ...(pinned ? { pinnedRank: String(threadNumber * 1024) } : {}),
      });
    }

    threads.push(...directoryThreads);
    directories.push({
      key: `directory:${directoryPath}`,
      kind: "directory",
      label: `Project ${directoryNumber}`,
      path: directoryPath,
      threadKeys: directoryThreads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
      needsAttentionCount: 0,
      directoryThreadsCollapsed:
        options.directoryThreadsCollapsed ?? true,
    });
  }

  return {
    directories,
    threads,
    threadsByKey: new Map(
      threads.map((thread) => [
        buildThreadIdentityKey(thread.source, thread.id),
        thread,
      ]),
    ),
  };
}
