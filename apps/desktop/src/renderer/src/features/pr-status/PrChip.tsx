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

  return (
    <button
      type="button"
      aria-label={`Open ${pr.org}/${pr.repo}#${pr.number} (${pr.state}) in browser`}
      title={tooltip}
      className={`pr-chip pr-chip--${pr.state}`}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen(pr.url);
      }}
    >
      <span className="pr-chip__dot" aria-hidden="true" />
      <span className="pr-chip__label">{label}</span>
    </button>
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
