import { classifyDirectory, federatedThreadIdentityKey } from "@pwragent/shared";
import type { NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared";
import type { NavigationQueryIndex } from "./navigation-query-projection";

/** Viewer-owned mount membership is separate from the remote owner's query inventory. */
export function appendViewerNavigationPins(index: NavigationQueryIndex, pins: readonly NavigationThreadSummary[]): NavigationQueryIndex {
  const directories = new Map(index.directories.map((directory) => [directory.key, { ...directory, threadKeys: [...directory.threadKeys] }]));
  for (const thread of pins) {
    if (!thread.federation || thread.federation.ref.target.scope !== "remote") continue;
    const identity = federatedThreadIdentityKey(thread.federation.ref);
    for (const linked of thread.linkedDirectories) {
      const descriptor = classifyDirectory(linked);
      let directory: NavigationDirectorySummary | undefined = directories.get(descriptor.key);
      if (!directory) {
        directory = { ...descriptor, localAvailability: "unconfigured", threadKeys: [], needsAttentionCount: 0 };
        directories.set(descriptor.key, directory);
      }
      if (!directory.threadKeys.includes(identity)) directory.threadKeys.push(identity);
      directory.latestUpdatedAt = Math.max(directory.latestUpdatedAt ?? 0, thread.updatedAt ?? 0);
    }
  }
  return { ...index, directories: [...directories.values()], threads: [...index.threads, ...pins] };
}
