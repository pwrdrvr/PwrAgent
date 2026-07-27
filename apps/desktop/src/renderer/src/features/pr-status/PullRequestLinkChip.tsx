import type { PrSummary } from "@pwragent/shared";
import type { ReactNode } from "react";
import {
  useLivePullRequest,
  useLivePullRequestNumber,
} from "../../lib/pull-request-links";
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

export function PullRequestNumberLinkChip(props: {
  children: ReactNode;
  number: number;
}) {
  const pr = useLivePullRequestNumber(props.number);
  return pr ? <PullRequestLinkChip pr={pr} /> : <>{props.children}</>;
}

function openPullRequest(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
