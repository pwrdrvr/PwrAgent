import type { NavigationThreadSummary } from "@pwragent/shared";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { resolveLaunchpadComposerScope } from "../composer/launchpad-composer-handoff";
import {
  buildThreadComposerScopeKey,
  type ComposerDraftStore,
} from "../composer/useComposerDraftStore";

/**
 * ThreadView renders its launchpad and its thread as separate branches, and
 * each branch mounts its own composer. Starting a thread switches branches,
 * so the operator typing in the launchpad would get a new composer
 * mid-sentence: a new editor, a lost caret, and keys dropped while it mounts.
 * Both branches therefore wrap the composer in one keyed slot, and the thread
 * a launchpad just became takes the launchpad's key. React then keeps the
 * same composer, which retargets itself to the thread (see
 * `followsMaterialization` in Composer).
 *
 * Every other move between a launchpad and a thread keeps the thread key, so
 * it still mounts a fresh composer.
 */
export type ComposerSlotLineage = {
  /** The composer scope of the launchpad this view last showed. */
  launchpadScope?: string;
  /** The thread that launchpad became, once this view has shown it. */
  threadScope?: string;
};

export const LAUNCHPAD_COMPOSER_SLOT_KEY = "launchpad-composer";
export const THREAD_COMPOSER_SLOT_KEY = "thread-composer";

/** The scope a launchpad Composer uses, from the props ThreadView passes it. */
export function launchpadComposerScope(
  directoryKey: string,
  composerScopeKey: string | undefined,
): string {
  return composerScopeKey ?? `launchpad:${directoryKey}`;
}

/** The scope a thread Composer uses for this thread. */
export function threadComposerScope(
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">,
): string {
  return buildThreadComposerScopeKey(
    thread.source,
    thread.id,
    thread.federation?.ref.target
      ?? readRendererFederationTarget()
      ?? { scope: "local" },
  );
}

/**
 * Returns `current` unchanged when nothing moved, so a caller storing this
 * in state settles after one update.
 */
export function nextComposerSlotLineage(
  current: ComposerSlotLineage,
  view: { launchpadScope?: string; threadScope?: string },
  store: ComposerDraftStore | undefined,
): ComposerSlotLineage {
  if (view.launchpadScope) {
    return current.launchpadScope === view.launchpadScope && !current.threadScope
      ? current
      : { launchpadScope: view.launchpadScope };
  }
  if (current.launchpadScope && view.threadScope) {
    if (current.threadScope === view.threadScope) return current;
    // The handoff records where the launchpad's draft went. Only the thread
    // it went to adopts the launchpad's composer.
    if (
      !current.threadScope
      && store
      && resolveLaunchpadComposerScope(store, current.launchpadScope)
        === view.threadScope
    ) {
      return { launchpadScope: current.launchpadScope, threadScope: view.threadScope };
    }
  }
  return current.launchpadScope ? {} : current;
}

export function composerSlotKey(
  lineage: ComposerSlotLineage,
  view: { launchpadScope?: string; threadScope?: string },
): string {
  return view.launchpadScope
    || (view.threadScope !== undefined && lineage.threadScope === view.threadScope)
    ? LAUNCHPAD_COMPOSER_SLOT_KEY
    : THREAD_COMPOSER_SLOT_KEY;
}
