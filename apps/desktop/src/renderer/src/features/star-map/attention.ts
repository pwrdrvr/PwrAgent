import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { isThreadActive } from "../navigation/ThreadRowStatus";
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
  const key = threadSummaryIdentityKey(thread);
  const categories: StarMapAttentionCategory[] = [];
  if (thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen") {
    categories.push("unread");
  }
  // The sidebar's predicate, not a copy of it. `isThreadActive` carries a
  // standing instruction to keep it shared "so their numbers match the
  // animated thread-row marker exactly" — and the map had drifted into its
  // own copy, which is the drift that instruction exists to prevent.
  if (isThreadActive(thread, sessionKeys?.thinkingThreadKeys)) {
    categories.push("active");
  }
  if (
    ("needsInput" in thread && thread.needsInput === true)
    || sessionKeys?.approvalRequestThreadKeys?.[key] === true
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
 * Whether a thread is driven by a named agent. `thread.agent` is the same
 * marker the row's "Agent" badge reads.
 */
export function isAgentThread(thread: NavigationThreadSummary): boolean {
  return thread.agent !== undefined;
}
