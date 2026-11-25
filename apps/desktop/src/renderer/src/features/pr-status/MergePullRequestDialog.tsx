import { useId, useRef, useState, type RefObject } from "react";
import type { PrSummary, ThreadPullRequestMergeTarget } from "@pwragent/shared/contracts/navigation";
import {
  THREAD_TODO_MERGE_METHOD_LABELS,
  type ThreadTodoMergeMethod,
} from "@pwragent/shared/contracts/thread-todos";
import { PendingSpinner } from "../../components/PendingSpinner";
import { Select } from "../../components/Select";
import { useModalDialog } from "../../lib/useModalDialog";
import type { CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import { githubStackMergeNote } from "@pwragent/shared/pull-request-merge-offer";
import {
  pullRequestMergeButtonLabel,
  pullRequestMergeCheckWarning,
  pullRequestMergeQuestion,
  pullRequestStackMergePlan,
} from "./PrCardMergeControl";
import type { PullRequestMergeService } from "./pull-request-merge-context";
import { usePullRequestMergeOffer } from "./usePullRequestMergeOffer";

/**
 * The chip menu's Merge Pull Request…: the PR card's merge for the keyboard,
 * whose footer is a pointer shortcut. It opens on the method the card's
 * button runs; choosing another one makes it the project's, as the card's
 * method list does. The result arrives as a toast, as the card's does.
 */
export function MergePullRequestDialog(props: {
  pr: PrSummary;
  thread: ThreadPullRequestMergeTarget;
  service: PullRequestMergeService;
  /** The PR's stack membership: a GitHub stack's merge can land layers below it. */
  stack?: CompactStackMembership;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const { pr, service } = props;
  const offer = usePullRequestMergeOffer(pr, props.thread, service);
  const [picked, setPicked] = useState<ThreadTodoMergeMethod>();
  const [running, setRunning] = useState(false);
  const titleId = useId();
  const methodId = useId();
  // Cancel first: this confirms an action that cannot be taken back.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({
    onClose: props.onClose,
    initialFocus: cancelRef,
    ...(props.returnFocus === undefined ? {} : { returnFocus: props.returnFocus }),
  });
  const stackPlan = offer.kind === "merge" ? pullRequestStackMergePlan(props.stack, props.thread) : undefined;
  const method = offer.kind === "merge" && stackPlan?.kind !== "merge_below_first"
    ? picked && offer.methods.includes(picked) ? picked : offer.method
    : undefined;
  const question = offer.kind === "queue"
    ? pullRequestMergeQuestion(pr, { queue: offer.noun })
    : method ? pullRequestMergeQuestion(pr, { method }, stackPlan) : `Merge #${pr.number}?`;
  const runnable = offer.kind === "queue" || method !== undefined;
  const warning = runnable ? pullRequestMergeCheckWarning(pr) : undefined;
  const merge = (): void => {
    if (running) return;
    setRunning(true);
    void service.merge({
      thread: props.thread,
      pr,
      method: method ?? "squash",
      rememberMethod: offer.kind === "merge" && method !== offer.method,
      ...(stackPlan?.kind === "with_layers_below" ? { mergeOpenLayersBelow: stackPlan.below } : {}),
    }).finally(props.onClose);
  };

  return (
    <div
      className="pr-detach-warning-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        aria-busy={running}
        className="pr-detach-warning-dialog pr-merge-dialog"
        role="dialog"
      >
        <h2 id={titleId}>{question}</h2>
        <p className="pr-merge-dialog__context">
          {`${pr.org}/${pr.repo}${pr.title ? ` · ${pr.title}` : ""}`}
        </p>
        {offer.kind === "merge" && offer.methods.length > 1 ? (
          <div className="pr-merge-dialog__field">
            <span id={methodId} className="pr-merge-dialog__label">Merge method</span>
            <Select
              aria-labelledby={methodId}
              className="settings-select"
              disabled={running}
              value={method ?? offer.method}
              onChange={setPicked}
              options={offer.methods.map((value) => ({
                value,
                label: THREAD_TODO_MERGE_METHOD_LABELS[value].menu,
                description: THREAD_TODO_MERGE_METHOD_LABELS[value].description,
              }))}
            />
          </div>
        ) : null}
        {offer.kind === "loading" ? (
          <p role="status">Checking what merging waits for…</p>
        ) : offer.kind === "held" ? (
          <p role="status">Merge waits for {offer.waitingFor.join("; ")}.</p>
        ) : offer.kind === "never_merge" ? (
          <p role="status">
            {offer.projectLabel} never merges its pull requests. Change it from the project menu: Forge Automation.
          </p>
        ) : offer.kind === "none" ? (
          <p role="status">This pull request cannot be merged now.</p>
        ) : stackPlan?.kind === "merge_below_first" ? (
          <p role="status">{githubStackMergeNote(stackPlan, pr.number)}</p>
        ) : null}
        {stackPlan?.kind === "with_layers_below" ? (
          <p className="pr-merge-dialog__warning">{githubStackMergeNote(stackPlan, pr.number)}</p>
        ) : null}
        {runnable && warning ? <p className="pr-merge-dialog__warning">{warning}</p> : null}
        <div className="pr-detach-warning-dialog__actions">
          {running ? (
            <span className="pr-merge-dialog__running" role="status">
              <PendingSpinner pairing="paired" size="sm" />
              {offer.kind === "queue" ? "Adding to queue…" : "Merging…"}
            </span>
          ) : null}
          {/* Never disabled: a disabled control drops focus out of the
              dialog. Closing mid-merge leaves the merge running; its toast
              still reports it. */}
          <button ref={cancelRef} type="button" onClick={props.onClose}>
            {runnable && !running ? "Cancel" : "Close"}
          </button>
          {runnable ? (
            <button
              className="pr-merge-dialog__confirm"
              type="button"
              aria-disabled={running}
              onClick={merge}
            >
              {offer.kind === "queue" ? "Add to queue"
                : stackPlan?.kind === "with_layers_below" ? pullRequestMergeButtonLabel(method!, stackPlan)
                : THREAD_TODO_MERGE_METHOD_LABELS[method!].verb}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
