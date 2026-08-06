import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";

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
  if (
    thread.prs?.some(
      (pr) =>
        pr.state !== "merged"
        && pr.state !== "closed"
        && pr.lifecycleState !== "merged"
        && pr.lifecycleState !== "closed",
    )
  ) {
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
