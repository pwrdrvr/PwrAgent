import type { PrSummary } from "@pwragent/shared";
import { useLivePullRequest } from "../../lib/pull-request-links";
import { PrChip } from "./PrChip";

export function PullRequestLinkChip(props: { pr: PrSummary }) {
  const pr = useLivePullRequest(props.pr);

  return (
    <PrChip
      pr={pr}
      showRepoPrefix
      onOpen={openPullRequest}
    />
  );
}

function openPullRequest(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
