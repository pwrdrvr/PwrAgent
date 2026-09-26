import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared";
import { useCallback, useState, type ReactNode } from "react";
import { useTranscriptPullRequest } from "../../lib/transcript-pr-status";
import {
  useLivePullRequest,
  useLivePullRequestNumber,
} from "../../lib/pull-request-links";
import { PrChip } from "./PrChip";

export function PullRequestLinkChip(props: { pr: PrSummary }) {
  const key = buildPullRequestStatusKey(props.pr);
  const [interest, setInterest] = useState({ key, seen: false, visible: false });
  const onVisibilityChange = useCallback((visible: boolean) => {
    setInterest((previous) => previous.key === key && previous.visible === visible ? previous : {
      key,
      seen: (previous.key === key && previous.seen) || visible,
      visible,
    });
  }, [key]);
  const pr = useTranscriptPullRequest(useLivePullRequest(props.pr),
    interest.key === key ? interest : { seen: false, visible: false });

  return (
    <PrChip
      pr={pr}
      showRepoPrefix
      onOpen={openPullRequest}
      onVisibilityChange={onVisibilityChange}
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
