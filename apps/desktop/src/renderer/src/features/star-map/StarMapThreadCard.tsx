import type { CSSProperties } from "react";
import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { PrChip } from "../pr-status/PrChip";
import { ThreadMetaChips } from "../navigation/ThreadMetaChips";
import {
  getThreadRowStatus,
  ThreadRowStatus,
} from "../navigation/ThreadRowStatus";
import type { StarMapSessionKeys } from "./attention";

/**
 * Compact attention card floating in an instance's cloud. Mirrors the
 * thread-row anatomy (status cookie, title, meta chips, PR chips) a smidge
 * denser: project chips keep their meaning icons but drop the literal
 * "Local"/"Worktree" labels (linkedDirectoryMode="label"), and there is no
 * actions cluster.
 */
export function StarMapThreadCard(props: {
  thread: NavigationThreadSummary;
  sessionKeys?: StarMapSessionKeys;
  entering?: boolean;
  style?: CSSProperties;
  onOpen: (thread: NavigationThreadSummary) => void;
}) {
  const thread = props.thread;
  const threadKey = buildThreadIdentityKey(thread.source, thread.id);
  const status = getThreadRowStatus(
    thread,
    props.sessionKeys?.thinkingThreadKeys,
  );

  return (
    <button
      type="button"
      className={`star-map-card${props.entering ? " star-map-card--entering" : ""}`}
      style={props.style}
      data-thread-key={threadKey}
      onClick={() => props.onOpen(thread)}
    >
      <span className="star-map-card__heading">
        <ThreadRowStatus status={status} />
        <span className="star-map-card__title" title={thread.title}>
          {thread.title}
        </span>
      </span>
      <span className="star-map-card__chips">
        <ThreadMetaChips
          thread={thread}
          hasApprovalRequest={
            props.sessionKeys?.approvalRequestThreadKeys?.[threadKey] === true
          }
          hasInputRequest={
            props.sessionKeys?.inputRequestThreadKeys?.[threadKey] === true
          }
          includeLinkedDirectories
          linkedDirectoryMode="label"
        />
        {thread.prs?.map((pr) => (
          <PrChip
            key={`${pr.org}/${pr.repo}#${pr.number}`}
            pr={pr}
            showRepoPrefix={false}
            onOpen={(url) => {
              if (typeof window !== "undefined") {
                window.open(url, "_blank", "noopener,noreferrer");
              }
            }}
          />
        ))}
      </span>
    </button>
  );
}
