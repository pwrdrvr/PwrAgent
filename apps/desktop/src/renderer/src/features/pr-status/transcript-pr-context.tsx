import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  buildPullRequestStatusKey,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared/contracts/navigation";
import {
  resolvePrChipWatch,
  useThreadAutoFixRepository,
  useThreadPrWatches,
  type ThreadPrWatches,
} from "../pr-watches/useThreadPrWatchIndicators";
import type { PrBranchDrift } from "./pr-branch-drift";
import { useThreadPrBranchDrift } from "./thread-pr-branch-drift";

const TranscriptPrContext = createContext<{
  branchDrift?: PrBranchDrift;
  watches?: ThreadPrWatches;
  autoFixRepository?: string;
  attachmentsByKey?: ReadonlyMap<string, PrSummary>;
} | undefined>(undefined);

export function TranscriptPrContextProvider(props: {
  thread?: NavigationThreadSummary;
  children: ReactNode;
}) {
  const prs = props.thread?.prs;
  const branchDrift = useThreadPrBranchDrift(props.thread);
  const watches = useThreadPrWatches(props.thread);
  const autoFixRepository = useThreadAutoFixRepository(props.thread);
  const attachmentsByKey = useMemo(() => autoFixRepository && prs
    ? new Map(prs.map((pr) => [buildPullRequestStatusKey(pr), pr]))
    : undefined, [autoFixRepository, prs]);
  const value = useMemo(() => ({ branchDrift, watches, autoFixRepository, attachmentsByKey }),
    [branchDrift, watches, autoFixRepository, attachmentsByKey]);

  return <TranscriptPrContext.Provider value={value}>{props.children}</TranscriptPrContext.Provider>;
}

export function useTranscriptPrContext(pr: PrSummary, prKey: string) {
  const context = useContext(TranscriptPrContext);
  const attachment = context?.attachmentsByKey?.get(prKey);
  return {
    branchDrift: context?.branchDrift?.prKey === prKey ? context.branchDrift : undefined,
    watch: resolvePrChipWatch(context?.watches, pr,
      attachment ? context?.autoFixRepository : undefined, attachment),
  };
}
