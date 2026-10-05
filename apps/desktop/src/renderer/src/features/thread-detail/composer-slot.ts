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
 * Both branches therefore wrap the composer in a keyed slot. The launchpad
 * slot and the thread slot always hold different keys, except that the
 * thread a launchpad just became takes the launchpad's key: the two keys
 * swap. React then keeps that composer, which retargets itself to the thread
 * (see `followsMaterialization` in Composer).
 *
 * Every other move keeps its old behavior. A launchpad and a thread never
 * share a composer, and moving between threads, or between launchpads, keeps
 * the one composer each branch already had.
 */
export type ComposerSlotLineage = {
  /** The composer scope of the launchpad this view showed last, until a thread shows. */
  launchpadScope?: string;
  /** Whether the two slot keys have swapped an odd number of times. */
  swapped?: boolean;
};

const COMPOSER_SLOT_KEYS = ["composer-slot-a", "composer-slot-b"] as const;

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
    return current.launchpadScope === view.launchpadScope
      ? current
      : { ...current, launchpadScope: view.launchpadScope };
  }
  if (!current.launchpadScope) return current;
  // The first view after a launchpad decides. The handoff records where the
  // launchpad's draft went, and only the thread it went to adopts the
  // launchpad's composer.
  const adopted = view.threadScope !== undefined
    && store !== undefined
    && resolveLaunchpadComposerScope(store, current.launchpadScope)
      === view.threadScope;
  return { swapped: adopted ? !current.swapped : current.swapped };
}

export function composerSlotKey(
  lineage: ComposerSlotLineage,
  view: { launchpadScope?: string },
): string {
  const [launchpadKey, threadKey] = lineage.swapped
    ? [COMPOSER_SLOT_KEYS[1], COMPOSER_SLOT_KEYS[0]]
    : COMPOSER_SLOT_KEYS;
  return view.launchpadScope ? launchpadKey : threadKey;
}
