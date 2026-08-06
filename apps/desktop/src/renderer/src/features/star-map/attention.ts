import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { isOpenPullRequest } from "./star-map-preferences";

export const STAR_MAP_ATTENTION_CATEGORIES = [
  "unread",
  "active",
  "approval",
  "pr",
  "unpushed",
] as const;

export type StarMapAttentionCategory =
  (typeof STAR_MAP_ATTENTION_CATEGORIES)[number];

export const STAR_MAP_ATTENTION_LABELS: Record<StarMapAttentionCategory, string> = {
  unread: "Unread",
  active: "Working",
  approval: "Needs input",
  pr: "Open PR",
  unpushed: "Unpushed",
};

export type StarMapSessionKeys = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  inputRequestThreadKeys?: Record<string, boolean>;
  thinkingThreadKeys?: Record<string, boolean>;
};

/** Which attention categories a thread currently matches. */
export function threadAttentionCategories(
  thread: NavigationThreadSummary,
  sessionKeys?: StarMapSessionKeys,
): StarMapAttentionCategory[] {
  const key = buildThreadIdentityKey(thread.source, thread.id);
  const categories: StarMapAttentionCategory[] = [];
  if (thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen") {
    categories.push("unread");
  }
  if (
    thread.threadStatus === "active"
    || sessionKeys?.thinkingThreadKeys?.[key] === true
  ) {
    categories.push("active");
  }
  if (
    sessionKeys?.approvalRequestThreadKeys?.[key] === true
    || sessionKeys?.inputRequestThreadKeys?.[key] === true
  ) {
    categories.push("approval");
  }
  if (thread.prs?.some(isOpenPullRequest)) {
    categories.push("pr");
  }
  if ((thread.gitWorkingState?.unpushedCommits ?? 0) > 0) {
    categories.push("unpushed");
  }
  return categories;
}

/**
 * Threads that need attention, filtered to the enabled categories, ordered
 * by recent activity. Archived threads never surface on the map.
 */
export function selectAttentionThreads(params: {
  threads: readonly NavigationThreadSummary[];
  enabled: ReadonlySet<StarMapAttentionCategory>;
  sessionKeys?: StarMapSessionKeys;
}): NavigationThreadSummary[] {
  return params.threads
    .filter((thread) => thread.archivedAt === undefined)
    .filter((thread) =>
      threadAttentionCategories(thread, params.sessionKeys).some((category) =>
        params.enabled.has(category),
      ),
    )
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

/**
 * How many cards each filter chip is responsible for right now: for an
 * enabled category, the threads that would DISAPPEAR if it were switched
 * off (it is their only enabled reason); for a disabled category, the
 * threads that would APPEAR if it were switched on (nothing else in the
 * enabled set currently claims them). Either way the number answers "how
 * many cards does flipping this change".
 */
export function countFilterImpact(params: {
  threads: readonly NavigationThreadSummary[];
  enabled: ReadonlySet<StarMapAttentionCategory>;
  sessionKeys?: StarMapSessionKeys;
}): Record<StarMapAttentionCategory, number> {
  const counts = Object.fromEntries(
    STAR_MAP_ATTENTION_CATEGORIES.map((category) => [category, 0]),
  ) as Record<StarMapAttentionCategory, number>;
  for (const thread of params.threads) {
    if (thread.archivedAt !== undefined) continue;
    const categories = threadAttentionCategories(thread, params.sessionKeys);
    const enabledMatches = categories.filter((category) =>
      params.enabled.has(category),
    );
    for (const category of categories) {
      if (params.enabled.has(category)) {
        // Removing this chip only drops the card when nothing else keeps it.
        if (enabledMatches.length === 1) counts[category] += 1;
      } else if (enabledMatches.length === 0) {
        counts[category] += 1;
      }
    }
  }
  return counts;
}

export function addFilterImpactCounts(
  left: Record<StarMapAttentionCategory, number>,
  right: Record<StarMapAttentionCategory, number>,
): Record<StarMapAttentionCategory, number> {
  return Object.fromEntries(
    STAR_MAP_ATTENTION_CATEGORIES.map((category) => [
      category,
      left[category] + right[category],
    ]),
  ) as Record<StarMapAttentionCategory, number>;
}
