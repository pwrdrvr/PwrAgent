import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { resolveLifecycleState } from "../pr-status/pr-chip-state";
import {
  canWatchPrCi,
  isCiWatch,
  readWatchRunAttempt,
  useThreadPrWatches,
  useThreadPrWatchIndicatorsContext,
} from "./useThreadPrWatchIndicators";

/**
 * The watch items in a PR chip's sidebar menu, between Copy Pull Request URL
 * and Detach Pull Request. Local threads only: a peer's watches run on the
 * peer, which no signed request can start or stop from here.
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
  if (!context || props.thread.federation) {
    return null;
  }
  const prKey = buildPullRequestStatusKey(props.pr);
  const watches = threadWatches?.watches.filter((watch) => watch.prKey === prKey) ?? [];
  const ciWatch = watches.find(isCiWatch);
  const terminalWatch = watches.find((watch) => !isCiWatch(watch));
  const stop = context.stop;
  const ask = context.askAgentToWatchCi;
  const watchCi = context.watchCi;
  const canAsk = Boolean(ask) && !ciWatch && resolveLifecycleState(props.pr) === "open";
  const canWatch = Boolean(watchCi) && !ciWatch && canWatchPrCi(props.thread, props.pr);
  if (!(stop && (ciWatch || terminalWatch)) && !canAsk && !canWatch) {
    return null;
  }
  const runAttempt = ciWatch ? readWatchRunAttempt(ciWatch) : undefined;
  return (
    <>
      <div className="thread-context-menu__separator" role="separator" />
      {stop && ciWatch ? (
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            props.onClose();
            void stop(ciWatch);
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
            void stop(terminalWatch);
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
