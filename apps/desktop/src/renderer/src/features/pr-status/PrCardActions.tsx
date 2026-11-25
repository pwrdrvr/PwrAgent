import type { PrSummary, ThreadPullRequestMergeTarget } from "@pwragent/shared/contracts/navigation";
import type { CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import { copyText } from "../../lib/copy-text";
import { PrCardMergeControl } from "./PrCardMergeControl";
import type { PullRequestMergeService } from "./pull-request-merge-context";

export type PrCardMerge = { thread: ThreadPullRequestMergeTarget; service: PullRequestMergeService };

export function PrCardActions(props: {
  pr: PrSummary;
  onDismiss: () => void;
  onDetach?: () => void;
  merge?: PrCardMerge;
  /** The PR's stack membership: a GitHub stack's merge can land layers below it. */
  stack?: CompactStackMembership;
  onLayoutChange: () => void;
}) {
  const { pr, onDismiss, onDetach, merge } = props;
  // Pointer shortcuts. The chip or list row keeps the keyboard's route to
  // these actions, and its description announces only the details.
  const buttons = (
    <>
      <button
        type="button"
        tabIndex={-1}
        className="pr-status-card__action"
        onClick={() => {
          onDismiss();
          void copyText(pr.url);
        }}
      >
        Copy URL
      </button>
      {onDetach ? (
        <button
          type="button"
          tabIndex={-1}
          className="pr-status-card__action pr-status-card__action--detach"
          onClick={onDetach}
        >
          Detach
        </button>
      ) : null}
    </>
  );
  return merge ? (
    <PrCardMergeControl
      key={pr.url}
      pr={pr}
      thread={merge.thread}
      service={merge.service}
      {...(props.stack ? { stack: props.stack } : {})}
      trailing={buttons}
      onLayoutChange={props.onLayoutChange}
    />
  ) : <div className="pr-status-card__actions" aria-hidden="true">{buttons}</div>;
}
