import { memo, useMemo, type ComponentProps } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { PrChip } from "../pr-status/PrChip";
import { PrRollupChip } from "../pr-status/PrRollupChip";
import { usePullRequestMergeService } from "../pr-status/pull-request-merge-context";
import {
  resolvePrChipWatch,
  useThreadAutoFixRepository,
  useThreadPrWatches,
} from "../pr-watches/useThreadPrWatchIndicators";

type WatchedThread = Pick<
  NavigationThreadSummary,
  "id" | "source" | "federation" | "prAutoDispatchEnabled" | "primaryGitRepository" | "prCiWatches"
>;

/**
 * What lets a row's PR card merge: only a local thread's, in a window that
 * merges. A thread another PwrAgent owns merges there, with its own holds.
 */
function useThreadPrMerge(thread: WatchedThread): ComponentProps<typeof PrChip>["merge"] {
  const service = usePullRequestMergeService();
  const local = !thread.federation;
  return useMemo(() => service && local
    ? { thread: { backend: thread.source, threadId: thread.id }, service }
    : undefined, [service, local, thread.source, thread.id]);
}

/**
 * A sidebar row's PR chip and its watch. The watch context is read here, not
 * in the row, so a watch change re-renders these small wrappers and never a
 * memoized row body. `resolvePrChipWatch` keeps an unchanged watch's
 * identity, so the chip itself still bails out.
 */
export const ThreadRowPrChip = memo(function ThreadRowPrChip(
  props: Omit<ComponentProps<typeof PrChip>, "watch"> & { thread: WatchedThread },
) {
  const { thread, ...chip } = props;
  const watches = useThreadPrWatches(thread);
  const autoFixRepository = useThreadAutoFixRepository(thread);
  const merge = useThreadPrMerge(thread);
  return (
    <PrChip
      {...chip}
      watch={resolvePrChipWatch(watches, chip.pr, autoFixRepository)}
      cardActions
      merge={merge}
    />
  );
});

/** Minimal density's one PR chip, reading the watch context the same way. */
export const ThreadRowPrRollupChip = memo(function ThreadRowPrRollupChip(
  props: Omit<ComponentProps<typeof PrRollupChip>, "prWatches" | "autoFixRepository"> & {
    thread: WatchedThread;
  },
) {
  const { thread, ...chip } = props;
  const prWatches = useThreadPrWatches(thread);
  const autoFixRepository = useThreadAutoFixRepository(thread);
  const merge = useThreadPrMerge(thread);
  return (
    <PrRollupChip
      {...chip}
      prWatches={prWatches}
      autoFixRepository={autoFixRepository}
      merge={merge}
    />
  );
});
