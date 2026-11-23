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
  attachedPrKeys?: ReadonlySet<string>;
} | undefined>(undefined);

export function TranscriptPrContextProvider(props: {
  thread?: NavigationThreadSummary;
  children: ReactNode;
}) {
  const prs = props.thread?.prs;
  const branchDrift = useThreadPrBranchDrift(props.thread);
  const watches = useThreadPrWatches(props.thread);
  const autoFixRepository = useThreadAutoFixRepository(props.thread);
  const attachedPrKeys = useMemo(() => autoFixRepository && prs
    ? new Set(prs.map(buildPullRequestStatusKey))
    : undefined, [autoFixRepository, prs]);
  const value = useMemo(() => ({ branchDrift, watches, autoFixRepository, attachedPrKeys }),
    [branchDrift, watches, autoFixRepository, attachedPrKeys]);

  return <TranscriptPrContext.Provider value={value}>{props.children}</TranscriptPrContext.Provider>;
}

export function useTranscriptPrContext(pr: PrSummary, prKey: string) {
  const context = useContext(TranscriptPrContext);
  return {
    branchDrift: context?.branchDrift?.prKey === prKey ? context.branchDrift : undefined,
    watch: resolvePrChipWatch(context?.watches, pr,
      context?.attachedPrKeys?.has(prKey) ? context.autoFixRepository : undefined),
  };
}
