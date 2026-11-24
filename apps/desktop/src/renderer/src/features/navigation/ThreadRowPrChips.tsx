import { memo, useMemo, type ComponentProps } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { PrChip } from "../pr-status/PrChip";
import { PrRollupChip } from "../pr-status/PrRollupChip";
import {
  threadPullRequestMergeTarget,
  usePullRequestMergeService,
} from "../pr-status/pull-request-merge-context";
import {
  resolvePrChipWatch,
  useThreadAutoFixRepository,
  useThreadPrWatches,
} from "../pr-watches/useThreadPrWatchIndicators";

/**
 * What lets a row's PR card merge. A thread another PwrAgent owns merges
 * there, with its own holds, when that owner accepts the request.
 */
function useThreadPrMerge(thread: NavigationThreadSummary): ComponentProps<typeof PrChip>["merge"] {
  const service = usePullRequestMergeService();
  const target = service ? threadPullRequestMergeTarget(thread) : undefined;
  // Keyed on the route, not the row's federation object, which a navigation
  // snapshot rebuilds with equal content: the memoized chip keeps bailing out.
  const owner = target?.federationTarget?.scope === "remote" ? target.federationTarget.instanceId : undefined;
  const routed = target !== undefined;
  const { source, id } = thread;
  return useMemo(() => service && routed
    ? {
        thread: {
          backend: source,
          threadId: id,
          ...(owner ? { federationTarget: { scope: "remote" as const, instanceId: owner } } : {}),
        },
        service,
      }
    : undefined, [service, routed, owner, source, id]);
}

/**
 * A sidebar row's PR chip and its watch. The watch context is read here, not
 * in the row, so a watch change re-renders these small wrappers and never a
 * memoized row body. `resolvePrChipWatch` keeps an unchanged watch's
 * identity, so the chip itself still bails out.
 */
export const ThreadRowPrChip = memo(function ThreadRowPrChip(
  props: Omit<ComponentProps<typeof PrChip>, "watch"> & { thread: NavigationThreadSummary },
) {
  const { thread, ...chip } = props;
  const watches = useThreadPrWatches(thread);
  const autoFixRepository = useThreadAutoFixRepository(thread);
  const merge = useThreadPrMerge(thread);
  return (
    <PrChip
      {...chip}
      watch={resolvePrChipWatch(watches, chip.pr, autoFixRepository)}
      stackThread={thread}
      showStackTag
      cardActions
      merge={merge}
    />
  );
});

/** Minimal density's one PR chip, reading the watch context the same way. */
export const ThreadRowPrRollupChip = memo(function ThreadRowPrRollupChip(
  props: Omit<ComponentProps<typeof PrRollupChip>, "prWatches" | "autoFixRepository"> & {
    thread: NavigationThreadSummary;
  },
) {
  const { thread, ...chip } = props;
  const prWatches = useThreadPrWatches(thread);
  const autoFixRepository = useThreadAutoFixRepository(thread);
  const merge = useThreadPrMerge(thread);
  return (
    <PrRollupChip
      {...chip}
      stackThread={thread}
      prWatches={prWatches}
      autoFixRepository={autoFixRepository}
      merge={merge}
    />
  );
});
