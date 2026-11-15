import type { NavigationThreadSummary } from "@pwragent/shared";

/**
 * A project path split for middle truncation: `head` is everything up to and
 * including the last separator, `tail` the folder name. The card lets only
 * the head shrink, so the browser's ellipsis lands in the middle of the path
 * and the folder name always stays whole.
 */
export type ProjectPathParts = { head: string; tail: string };

export function splitProjectPath(path: string): ProjectPathParts {
  // A trailing separator would leave an empty tail; the root itself keeps it.
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const display = trimmed || path;
  const cut = Math.max(display.lastIndexOf("/"), display.lastIndexOf("\\"));
  if (cut < 0 || cut === display.length - 1) {
    return { head: "", tail: display };
  }
  return { head: display.slice(0, cut + 1), tail: display.slice(cut + 1) };
}

/** What the OS calls its file manager, as a "Show in …" action. */
export function revealInFileManagerLabel(platform: string | undefined): string {
  if (platform === "win32") return "Show in Explorer";
  if (platform === "darwin") return "Show in Finder";
  return "Show in File Manager";
}

/** How the card names the machine the window runs on. */
export function thisMachineLabel(platform: string | undefined): string {
  if (platform === "darwin") return "This Mac";
  if (platform === "win32") return "This PC";
  return "This machine";
}

/**
 * The peers a project card offers, at most `limit` of them.
 *
 * Only peers that can take a thread now are offered; the full menu behind
 * "Other machines…" still lists the rest with their reasons. Order: the peer
 * whose newest thread this window has loaded is most recent comes first, so
 * the machines in use float up; peers with no loaded thread keep the menu's
 * order after them. `more` says whether the full menu holds anything the card
 * left out.
 */
export function rankProjectCardPeers<
  Target extends { instanceId: string; availability: string },
>(
  targets: readonly Target[],
  threads: readonly Pick<NavigationThreadSummary, "updatedAt" | "federation">[],
  limit = 2,
): { peers: Target[]; more: boolean } {
  const newest = new Map<string, number>();
  for (const thread of threads) {
    const target = thread.federation?.ref.target;
    if (target?.scope !== "remote") continue;
    const updatedAt = thread.updatedAt ?? 0;
    const seen = newest.get(target.instanceId);
    if (seen === undefined || updatedAt > seen) {
      newest.set(target.instanceId, updatedAt);
    }
  }
  const ranked = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => target.availability === "available")
    .sort((left, right) => {
      const leftAt = newest.get(left.target.instanceId);
      const rightAt = newest.get(right.target.instanceId);
      if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) {
        return rightAt - leftAt;
      }
      if (leftAt !== undefined && rightAt === undefined) return -1;
      if (leftAt === undefined && rightAt !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ target }) => target);
  const peers = ranked.slice(0, Math.max(0, limit));
  return { peers, more: targets.length > peers.length };
}
