import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { resolveLifecycleState } from "../pr-status/pr-chip-state";
import {
  canManageThreadPrWatches,
  canWatchPrCi,
  isCiWatch,
  readWatchRunAttempt,
  useThreadPrWatches,
  useThreadPrWatchIndicatorsContext,
  type PrWatchStopTarget,
} from "./useThreadPrWatchIndicators";

/**
 * The watch items in a PR chip's sidebar menu, between Copy Pull Request URL
 * and Detach Pull Request. A peer's thread shows them when its owner accepts
 * them (`canManageThreadPrWatches`). Its row marks only CI watches, so a
 * peer's menu has no Stop Watching for Merge.
 *
 * Watch CI arms the watch at once. Ask Agent to Watch CI stays beside it: it
 * drafts the request so the operator can add instructions for the wake, and
 * it shows the phrasing that works in any thread.
 *
 * Its own component so the sidebar does not re-render when watches change.
 */
export function PullRequestWatchMenuItems(props: {
  thread: NavigationThreadSummary;
  pr: PrSummary;
  /** Closes the menu before an item acts. */
  onClose: () => void;
}) {
  const context = useThreadPrWatchIndicatorsContext();
  const threadWatches = useThreadPrWatches(props.thread);
  if (!context || !canManageThreadPrWatches(context, props.thread)) {
    return null;
  }
  const prKey = buildPullRequestStatusKey(props.pr);
  const watches = threadWatches?.watches.filter((watch) => watch.prKey === prKey) ?? [];
  const localCiWatch = watches.find(isCiWatch);
  // A peer's row names its CI watch by mark.
  const peerMark = props.thread.federation
    ? props.thread.prCiWatches?.filter((mark) => mark.prKey === prKey).at(-1)
    : undefined;
  const ciWatch: PrWatchStopTarget | undefined = localCiWatch ?? (peerMark
    ? { backend: props.thread.source, threadId: props.thread.id, watchId: peerMark.watchId }
    : undefined);
  const terminalWatch = watches.find((watch) => !isCiWatch(watch));
  const stop = context.stop;
  const ask = context.askAgentToWatchCi;
  const watchCi = context.watchCi;
  const canAsk = Boolean(ask) && !ciWatch && resolveLifecycleState(props.pr) === "open";
  const canWatch = Boolean(watchCi) && !ciWatch && canWatchPrCi(props.thread, props.pr);
  if (!(stop && (ciWatch || terminalWatch)) && !canAsk && !canWatch) {
    return null;
  }
  const runAttempt = localCiWatch ? readWatchRunAttempt(localCiWatch) : peerMark?.runAttempt;
  return (
    <>
      <div className="thread-context-menu__separator" role="separator" />
      {stop && ciWatch ? (
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            props.onClose();
            void stop(ciWatch, props.thread);
          }}
        >
          <span>Stop Waiting for CI</span>
          {runAttempt !== undefined ? (
            <span className="thread-context-menu__aside thread-context-menu__aside--mono">
              attempt {runAttempt}
            </span>
          ) : null}
        </button>
      ) : null}
      {stop && terminalWatch ? (
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            props.onClose();
            void stop(terminalWatch, props.thread);
          }}
        >
          Stop Watching for Merge
        </button>
      ) : null}
      {canWatch ? (
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            props.onClose();
            void watchCi!(props.thread, props.pr);
          }}
        >
          Watch CI
        </button>
      ) : null}
      {canAsk ? (
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            props.onClose();
            ask!(props.thread, props.pr);
          }}
        >
          Ask Agent to Watch CI
        </button>
      ) : null}
      <div className="thread-context-menu__separator" role="separator" />
    </>
  );
}
