import type { KeyboardEvent, MouseEvent } from "react";
import type { PrSummary } from "@pwragent/shared";

type PrChipProps = {
  pr: PrSummary;
  /** When the thread spans multiple repos, render the org/repo prefix. */
  showRepoPrefix: boolean;
  onOpen: (url: string) => void;
};

export function PrChip(props: PrChipProps) {
  const { pr } = props;
  const label = props.showRepoPrefix
    ? `${pr.org}/${pr.repo}#${pr.number}`
    : `#${pr.number}`;
  const tooltip = `${pr.org}/${pr.repo}#${pr.number} — ${stateTooltipLabel(pr.state)}`;

  // role="button" span (not a real <button>) so the chip is legal HTML
  // inside the row's main <button>. stopPropagation prevents the row's
  // "select thread" click from firing when the user is opening a PR.
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    props.onOpen(pr.url);
  };

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Open ${pr.org}/${pr.repo}#${pr.number} (${pr.state}) in browser`}
      title={tooltip}
      className={`pr-chip pr-chip--${pr.state}`}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          handleActivate(event);
        }
      }}
    >
      <span className="pr-chip__dot" aria-hidden="true" />
      <span className="pr-chip__label">{label}</span>
    </span>
  );
}

function stateTooltipLabel(state: PrSummary["state"]): string {
  switch (state) {
    case "merged":
      return "merged";
    case "passing":
      return "all checks passing";
    case "failing":
      return "checks failing";
    case "draft":
      return "draft";
    case "pending":
      return "checks pending";
    case "closed":
      return "closed without merge";
    case "unknown":
      return "status unknown";
  }
}
