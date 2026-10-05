import { useState } from "react";

import { COMPOSER_TIPS } from "./composer-tips";

// Shared across every reply composer in the window, so consecutive threads
// show consecutive tips instead of each one restarting at the first tip. A
// launch always starts at the first tip, so screenshot captures that show an
// empty reply box come out the same on every run.
let nextTipIndex = 0;

function takeNextTipIndex(): number {
  const index = nextTipIndex;
  nextTipIndex = (nextTipIndex + 1) % COMPOSER_TIPS.length;
  return index;
}

interface ComposerTipState {
  scopeKey: string | undefined;
  empty: boolean;
  index: number | undefined;
}

/**
 * The tip a reply composer shows while it is empty, or `undefined` when
 * `scopeKey` is. A composer that shows no tips (New thread) passes no scope,
 * so it does not spend tips nobody sees.
 *
 * The tip changes only when the operator could not be reading it: when the
 * composer moves to another thread, or when it empties again after holding a
 * draft (a send, or the operator clearing the box). It never rotates on a
 * timer, because text that changes under the eye reads as a notification.
 */
export function useComposerTip(scopeKey: string | undefined, empty: boolean): string | undefined {
  const [state, setState] = useState<ComposerTipState>(() => ({
    scopeKey,
    empty,
    index: scopeKey === undefined ? undefined : takeNextTipIndex(),
  }));
  let index = state.index;
  if (state.scopeKey !== scopeKey || state.empty !== empty) {
    // Adjusting state while rendering, React's pattern for state derived from
    // a previous render: the next render reads the settled value.
    if (scopeKey === undefined) {
      index = undefined;
    } else if (
      index === undefined
      || state.scopeKey !== scopeKey
      || (empty && !state.empty)
    ) {
      index = takeNextTipIndex();
    }
    setState({ scopeKey, empty, index });
  }
  return index === undefined ? undefined : COMPOSER_TIPS[index]!();
}

/** Test seam: make the next composer show the tip at `index`. */
export function resetComposerTipRotationForTests(index = 0): void {
  nextTipIndex = index;
}
