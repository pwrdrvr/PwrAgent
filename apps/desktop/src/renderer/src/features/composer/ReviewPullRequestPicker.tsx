import { useId, type ReactNode, type Ref } from "react";
import type { PrSummary } from "@pwragent/shared";
import { PrChip } from "../pr-status/PrChip";
import { prStatusLabel, resolveLifecycleState } from "../pr-status/pr-chip-state";
import { prStackTimeLabel, resolvePrRollup } from "../pr-status/pr-rollup";

/**
 * The Attached PR review target's list of pull requests.
 *
 * It lists PRs the way the sidebar's PR popover does: open PRs on top, newest
 * opened first, then merged and closed PRs, newest finished first
 * (`resolvePrRollup().ordered`). Each row prints the state and the time it is
 * sorted by. The chip is the standard `PrChip`, so hovering it shows the PR
 * card. A native select had none of this: it listed PRs in attachment order,
 * oldest merged first, with no state.
 *
 * With `multiple`, rows are checkboxes, and each checked PR gets its own
 * review. Otherwise they are radios.
 */
export function ReviewPullRequestPicker(props: {
  prs: readonly PrSummary[];
  /** Checked PR URLs. */
  selectedUrls: readonly string[];
  multiple: boolean;
  /** "", the repository, or `org/repo`, when the list spans repositories. */
  repositoryLabel: (pr: PrSummary) => string;
  /** The new selection, in list order. */
  onChange: (urls: string[]) => void;
  /** The first row's input, for moving focus into the list. */
  firstInputRef?: Ref<HTMLInputElement>;
}) {
  const groupName = useId();
  const ordered = orderReviewPullRequests(props.prs);
  const open = ordered.filter((pr) => resolveLifecycleState(pr) === "open");
  const finished = ordered.filter((pr) => resolveLifecycleState(pr) !== "open");
  const selected = new Set(props.selectedUrls);
  const toggle = (url: string, checked: boolean): void => {
    if (!props.multiple) {
      props.onChange(checked ? [url] : []);
      return;
    }
    const next = new Set(selected);
    if (checked) {
      next.add(url);
    } else {
      next.delete(url);
    }
    props.onChange(ordered.map((pr) => pr.url).filter((candidate) => next.has(candidate)));
  };
  const groups = [
    { label: "Open", prs: open },
    { label: finishedGroupLabel(finished), prs: finished },
  ].filter((group) => group.prs.length > 0);
  let rowIndex = 0;
  return (
    <div
      className="review-pr-picker"
      role={props.multiple ? "group" : "radiogroup"}
      aria-label="Attached pull requests"
    >
      {groups.map((group) => (
        <ReviewPullRequestGroup key={group.label} label={group.label} count={group.prs.length}>
          {group.prs.map((pr) => {
            const index = rowIndex;
            rowIndex += 1;
            return (
              <ReviewPullRequestRow
                key={pr.url}
                pr={pr}
                checked={selected.has(pr.url)}
                multiple={props.multiple}
                groupName={groupName}
                repositoryLabel={props.repositoryLabel(pr)}
                inputRef={index === 0 ? props.firstInputRef : undefined}
                onToggle={(checked) => toggle(pr.url, checked)}
              />
            );
          })}
        </ReviewPullRequestGroup>
      ))}
    </div>
  );
}

/** The list's order, which is also the order checked PRs are reviewed in. */
export function orderReviewPullRequests(prs: readonly PrSummary[]): PrSummary[] {
  return resolvePrRollup(prs)?.ordered ?? [];
}

function finishedGroupLabel(prs: readonly PrSummary[]): string {
  const merged = prs.some((pr) => resolveLifecycleState(pr) === "merged");
  const closed = prs.some((pr) => resolveLifecycleState(pr) === "closed");
  return merged && closed ? "Merged or closed" : merged ? "Merged" : "Closed";
}

function ReviewPullRequestGroup(props: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="review-pr-picker__group" role="group" aria-labelledby={labelId}>
      <div id={labelId} className="review-pr-picker__group-label">
        {`${props.label} · ${props.count}`}
      </div>
      {props.children}
    </div>
  );
}

function ReviewPullRequestRow(props: {
  pr: PrSummary;
  checked: boolean;
  multiple: boolean;
  groupName: string;
  repositoryLabel: string;
  inputRef?: Ref<HTMLInputElement>;
  onToggle: (checked: boolean) => void;
}) {
  const { pr } = props;
  const inputId = useId();
  const statusId = useId();
  const title = pr.title ?? "Untitled pull request";
  const stackTime = prStackTimeLabel(pr);
  return (
    <div className={`review-pr-picker__row${props.checked ? " is-checked" : ""}`}>
      <input
        ref={props.inputRef}
        id={inputId}
        className="review-pr-picker__input"
        type={props.multiple ? "checkbox" : "radio"}
        name={props.multiple ? undefined : props.groupName}
        value={pr.url}
        checked={props.checked}
        aria-label={`${props.repositoryLabel}#${pr.number} ${title}`}
        aria-describedby={statusId}
        onChange={(event) => props.onToggle(event.currentTarget.checked)}
      />
      <PrChip
        pr={pr}
        showRepoPrefix={props.repositoryLabel !== ""}
        onOpen={openPullRequest}
      />
      <label htmlFor={inputId} className="review-pr-picker__text">
        <span className="review-pr-picker__title">{title}</span>
        <span id={statusId} className="review-pr-picker__status">
          {prStatusLabel(pr)}
          {pr.headRefName ? (
            <>
              {" · "}
              <span className="review-pr-picker__branch">{pr.headRefName}</span>
            </>
          ) : null}
        </span>
      </label>
      {stackTime ? (
        <label htmlFor={inputId} className="review-pr-picker__age">
          {stackTime}
        </label>
      ) : null}
    </div>
  );
}

function openPullRequest(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
