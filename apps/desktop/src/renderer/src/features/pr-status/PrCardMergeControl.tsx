import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PrSummary, ThreadPullRequestMergeTarget } from "@pwragent/shared/contracts/navigation";
import {
  THREAD_TODO_MERGE_METHOD_LABELS,
  type ThreadTodoMergeMethod,
} from "@pwragent/shared/contracts/thread-todos";
import { resolveCheckState } from "@pwragent/shared/pull-request-rollup";
import {
  githubStackMergeNote,
  resolveGithubStackMergePlan,
  type GithubStackMergePlan,
} from "@pwragent/shared/pull-request-merge-offer";
import type { CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import { PendingSpinner } from "../../components/PendingSpinner";
import { CheckIcon, ChevronDownIcon, MergeIcon, MergeQueueIcon } from "../../icons";
import type { PullRequestMergeService } from "./pull-request-merge-context";
import { usePullRequestMergeOffer } from "./usePullRequestMergeOffer";

type Phase =
  | { kind: "idle" }
  | { kind: "methods" }
  | { kind: "confirm"; method: ThreadTodoMergeMethod; remember: boolean }
  | { kind: "running" };

/** The question a merge asks before it runs, shared with the merge dialog. */
export function pullRequestMergeQuestion(
  pr: PrSummary,
  action: { queue: string } | { method: ThreadTodoMergeMethod },
  stack?: GithubStackMergePlan,
): string {
  const into = pr.baseRefName ? ` into ${pr.baseRefName}` : "";
  if ("queue" in action) {
    if (stack?.kind === "with_layers_below") {
      const branch = stack.trunk ?? pr.baseRefName;
      return `Add ${stack.count} PRs from its GitHub stack to the ${action.queue}${branch ? ` for ${branch}` : ""}?`;
    }
    return `Add #${pr.number} to the ${action.queue}${pr.baseRefName ? ` for ${pr.baseRefName}` : ""}?`;
  }
  if (stack?.kind === "with_layers_below") {
    // GitHub lands the stack on its trunk; the PR's own base is the layer below.
    const trunk = stack.trunk ? ` into ${stack.trunk}` : into;
    return `${THREAD_TODO_MERGE_METHOD_LABELS[action.method].verb} ${stack.count} PRs from its GitHub stack${trunk}?`;
  }
  return `${THREAD_TODO_MERGE_METHOD_LABELS[action.method].verb} #${pr.number}${into}?`;
}

/**
 * What merging `pr` does with its GitHub stack's open lower layers, as the
 * card and the merge dialog show it. See `resolveGithubStackMergePlan`.
 */
export function pullRequestStackMergePlan(
  stack: CompactStackMembership | undefined,
  thread: ThreadPullRequestMergeTarget,
): GithubStackMergePlan | undefined {
  return resolveGithubStackMergePlan({ member: stack, remote: thread.federationTarget?.scope === "remote" });
}

/** A merge button's label: a stack merge says how many PRs it lands. */
export function pullRequestMergeButtonLabel(method: ThreadTodoMergeMethod, stack: GithubStackMergePlan | undefined): string {
  const label = THREAD_TODO_MERGE_METHOD_LABELS[method].button;
  return stack?.kind === "with_layers_below" ? `${label} ${stack.count} PRs` : label;
}

/** One line when the head's checks have not passed; branch protection still decides. */
export function pullRequestMergeCheckWarning(pr: PrSummary): string | undefined {
  const checks = resolveCheckState(pr);
  if (checks === "failing") return "Checks are failing.";
  if (checks === "pending" || pr.checksStillRunning) return "Checks are still running.";
  return undefined;
}

/**
 * The sidebar PR card's footer with its merge control: the to-do card's
 * split pill (the label runs the project's method, the chevron lists the
 * repository's), then a confirmation. Everything stays inside the card. A
 * floating menu would take the pointer out of the hover card and close it.
 *
 * Like Copy URL and Detach, these are pointer shortcuts out of the Tab
 * order; the chip's menu offers the same merge through a dialog.
 */
export function PrCardMergeControl(props: {
  pr: PrSummary;
  thread: ThreadPullRequestMergeTarget;
  service: PullRequestMergeService;
  /** Copy URL, Detach: the footer's other buttons. */
  trailing: ReactNode;
  /** The PR's stack membership, which says whether a merge lands layers below it. */
  stack?: CompactStackMembership;
  /** The card's height changed, so it must be placed again. */
  onLayoutChange: () => void;
}) {
  const { pr, service, onLayoutChange } = props;
  const offer = usePullRequestMergeOffer(pr, props.thread, service);
  // GitHub's asynchronous merge lands the open layers below, queued or not.
  const stackPlan = offer.kind === "merge" || offer.kind === "queue"
    ? pullRequestStackMergePlan(props.stack, props.thread)
    : undefined;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // A card near the window's bottom edge has to move up as it grows.
  const layoutKey = `${phase.kind}|${offer.kind}|${stackPlan?.kind ?? ""}`;
  const firstLayout = useRef(true);
  useLayoutEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    onLayoutChange();
  }, [layoutKey, onLayoutChange]);

  const run = (method: ThreadTodoMergeMethod, remember: boolean): void => {
    setPhase({ kind: "running" });
    void service.merge({
      thread: props.thread, pr, method, rememberMethod: remember,
      ...(stackPlan?.kind === "with_layers_below" ? { mergeOpenLayersBelow: stackPlan.below } : {}),
    }).finally(() => {
      if (mounted.current) setPhase({ kind: "idle" });
    });
  };

  if (phase.kind === "confirm" && (offer.kind === "merge" || offer.kind === "queue")) {
    const warning = pullRequestMergeCheckWarning(pr);
    const plan = stackPlan;
    return (
      <div className="pr-status-card__confirm" aria-hidden="true">
        <span className="pr-status-card__confirm-question">
          {pullRequestMergeQuestion(pr, offer.kind === "queue" ? { queue: offer.noun } : { method: phase.method }, plan)}
        </span>
        {plan ? <span className="pr-status-card__confirm-warning">{githubStackMergeNote(plan, pr.number)}</span> : null}
        {warning ? <span className="pr-status-card__confirm-warning">{warning}</span> : null}
        <div className="pr-status-card__confirm-buttons">
          <button
            type="button"
            tabIndex={-1}
            className="button thread-todo-card__button thread-todo-card__button--quiet"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Cancel
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="button button--primary thread-todo-card__button"
            onClick={() => run(phase.method, phase.remember)}
          >
            {offer.kind === "queue" ? <MergeQueueIcon size={12} /> : <MergeIcon size={12} />}
            {offer.kind === "queue" ? plan?.kind === "with_layers_below" ? `Add ${plan.count} PRs to queue` : "Add to queue"
              : plan?.kind === "with_layers_below" ? pullRequestMergeButtonLabel(phase.method, plan)
              : THREAD_TODO_MERGE_METHOD_LABELS[phase.method].verb}
          </button>
        </div>
      </div>
    );
  }

  let control: ReactNode = null;
  if (phase.kind === "running") {
    control = (
      <span className="pr-status-card__merge-status">
        <PendingSpinner pairing="paired" size="sm" />
        {offer.kind === "queue" ? "Adding to queue…" : "Merging…"}
      </span>
    );
  } else if (offer.kind === "held") {
    control = (
      <span className="pr-status-card__merge-status">
        Merge waits for {offer.waitingFor.join("; ")}
      </span>
    );
  } else if (offer.kind === "never_merge") {
    control = (
      <span className="pr-status-card__merge-status">
        Merging off in Forge Automation
      </span>
    );
  } else if (stackPlan?.kind === "merge_below_first") {
    // A peer's owner takes no choice of lower layers, and would refuse.
    control = (
      <span className="pr-status-card__merge-status">
        {githubStackMergeNote(stackPlan, pr.number)}
      </span>
    );
  } else if (offer.kind === "queue") {
    const noun = offer.noun;
    control = (
      <button
        type="button"
        tabIndex={-1}
        className="button button--primary thread-todo-card__button"
        onClick={() => setPhase({ kind: "confirm", method: "squash", remember: false })}
      >
        <MergeQueueIcon size={12} />
        {offer.again ? `Add to ${noun} again`
          : stackPlan?.kind === "with_layers_below" ? `Add ${stackPlan.count} PRs to ${noun}` : `Add to ${noun}`}
      </button>
    );
  } else if (offer.kind === "merge" && offer.methods.length === 1) {
    control = (
      <button
        type="button"
        tabIndex={-1}
        className="button button--primary thread-todo-card__button"
        onClick={() => setPhase({ kind: "confirm", method: offer.method, remember: false })}
      >
        <MergeIcon size={12} />
        {pullRequestMergeButtonLabel(offer.method, stackPlan)}
      </button>
    );
  } else if (offer.kind === "merge") {
    const open = phase.kind === "methods";
    control = (
      <div className={`todo-split${open ? " todo-split--open" : ""}`}>
        <div className="todo-split__pill">
          <button
            type="button"
            tabIndex={-1}
            className="todo-split__chevron"
            aria-label="Merge options"
            aria-expanded={open}
            onClick={() => setPhase(open ? { kind: "idle" } : { kind: "methods" })}
          >
            <ChevronDownIcon size={12} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="todo-split__primary"
            onClick={() => setPhase({ kind: "confirm", method: offer.method, remember: false })}
          >
            <MergeIcon size={12} />
            {pullRequestMergeButtonLabel(offer.method, stackPlan)}
          </button>
        </div>
      </div>
    );
  }

  return (
    // The merge gets its own row: beside Copy URL and Detach it needs about
    // 290px of the card's 256.
    <div
      className="pr-status-card__actions pr-status-card__actions--merge"
      aria-hidden="true"
    >
      {control ? <div className="pr-status-card__merge-row">{control}</div> : null}
      {phase.kind === "methods" && offer.kind === "merge" ? (
        <div className="pr-status-card__methods">
          <span className="pr-status-card__section-title">Merge with</span>
          {offer.methods.map((method) => (
            <button
              key={method}
              type="button"
              tabIndex={-1}
              className="pr-status-card__method"
              onClick={() => setPhase({ kind: "confirm", method, remember: true })}
            >
              <span className="pr-status-card__method-check">
                {method === offer.method ? <CheckIcon size={12} /> : null}
              </span>
              <span className="pr-status-card__method-label">
                {THREAD_TODO_MERGE_METHOD_LABELS[method].menu}
              </span>
              <span className="pr-status-card__method-description">
                {THREAD_TODO_MERGE_METHOD_LABELS[method].description}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="pr-status-card__links">{props.trailing}</div>
    </div>
  );
}
