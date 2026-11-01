import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { resolveLifecycleState } from "../pr-status/pr-chip-state";
import {
  isCiWatch,
  useThreadPrWatches,
  useThreadPrWatchIndicatorsContext,
} from "./useThreadPrWatchIndicators";

/**
 * The watch items in a PR chip's sidebar menu, between Copy Pull Request URL
 * and Detach Pull Request. Local threads only: a peer's watches run on the
 * peer, which no signed request can stop from here.
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
  const canAsk = Boolean(ask) && !ciWatch && resolveLifecycleState(props.pr) === "open";
  if (!(stop && (ciWatch || terminalWatch)) && !canAsk) {
    return null;
  }
  const runAttempt = ciWatch?.baseline?.runAttempt;
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
