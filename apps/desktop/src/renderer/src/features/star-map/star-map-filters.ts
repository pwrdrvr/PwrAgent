import {
  buildThreadIdentityKey,
  comparePinnedThreads,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { isThreadRemoteWork } from "../navigation/ThreadRowStatus";
import {
  isAgentThread,
  threadAttentionCategories,
  type StarMapSessionKeys,
} from "./attention";

/**
 * Faceted filter chips.
 *
 * Each chip is tri-state. Nothing selected shows everything, one click
 * isolates, a second click excludes. The previous model started with every
 * chip ON and toggled them off, which meant isolating one signal cost a
 * click per *other* chip and "all off" was a reachable state that showed
 * an empty map.
 */
export type StarMapFilterState = "neutral" | "include" | "exclude";

/**
 * Chips are grouped into facets, and the grouping is what makes the model
 * work when the chips are not all the same kind of thing:
 *
 * - **within** a facet, includes OR together — "unread or has an open PR"
 * - **across** facets, they AND — "unread AND agent-driven"
 *
 * Unioning across facets would make "Unread + Agents" mean "unread or
 * agent-driven", which is never what an operator wants from two unrelated
 * questions. This is the standard behaviour of faceted filters elsewhere
 * (GitHub, Linear), and it is also why the agent chip used to need its own
 * state model: it was a second facet wearing the same clothes.
 */
export type StarMapFilterFacet = "attention" | "pinned" | "agent";

export type StarMapFilterKey =
  /**
   * Unread OR a live turn — the two signals the sidebar's Attention tab
   * carries as one tab with two indicators, and now the map's one chip
   * with the same two. They were separate chips, which made "show me what
   * wants me" two clicks and read as two unrelated questions.
   */
  | "attention"
  | "approval"
  | "pr"
  | "unpushed"
  | "pinned"
  | "agent";

export type StarMapFilterDefinition = {
  facet: StarMapFilterFacet;
  key: StarMapFilterKey;
  label: string;
};

export const STAR_MAP_FILTERS: readonly StarMapFilterDefinition[] = [
  { facet: "attention", key: "attention", label: "Attention" },
  { facet: "attention", key: "approval", label: "Needs input" },
  { facet: "attention", key: "pr", label: "Open PR" },
  { facet: "attention", key: "unpushed", label: "Unpushed" },
  { facet: "pinned", key: "pinned", label: "Pinned" },
  { facet: "agent", key: "agent", label: "Agents" },
];

export type StarMapFilterSelection = Partial<
  Record<StarMapFilterKey, StarMapFilterState>
>;

/** Neutral → include → exclude → neutral. */
export function cycleFilterState(
  current: StarMapFilterState | undefined,
): StarMapFilterState {
  if (current === "include") return "exclude";
  if (current === "exclude") return "neutral";
  return "include";
}

export function filterState(
  selection: StarMapFilterSelection,
  key: StarMapFilterKey,
): StarMapFilterState {
  return selection[key] ?? "neutral";
}

/** A thread is pinned when the navigation snapshot gave it a pin rank. */
export function isPinnedThread(thread: NavigationThreadSummary): boolean {
  return thread.pinnedRank !== undefined;
}

export function threadMatchesFilter(
  thread: NavigationThreadSummary,
  key: StarMapFilterKey,
  sessionKeys?: StarMapSessionKeys,
): boolean {
  if (key === "agent") return isAgentThread(thread);
  if (key === "pinned") return isPinnedThread(thread);
  const categories = threadAttentionCategories(thread, sessionKeys);
  if (key === "attention") {
    return categories.some(
      (category) => category === "unread" || category === "active",
    );
  }
  return categories.some((category) => category === key);
}

/**
 * The two numbers the Attention chip draws, and the split inside the
 * first of them.
 *
 * Counted the way `countFilterMatches` counts: against the threads that
 * already pass every OTHER facet, so the chip answers "how many is this
 * about right now" rather than a global tally. Live turns split local from
 * remote because the sidebar's Attention card does — quitting interrupts
 * the first and leaves the second running, so they are not interchangeable
 * even though both are "working".
 */
export type StarMapAttentionCounts = {
  activeLocal: number;
  activeRemote: number;
  unread: number;
};

/**
 * Frozen and module-private: its only job is to seed a fresh tally, and a
 * shared mutable "empty" is one careless caller away from every later
 * reader starting from a non-zero.
 */
const EMPTY_ATTENTION_COUNTS: StarMapAttentionCounts = Object.freeze({
  activeLocal: 0,
  activeRemote: 0,
  unread: 0,
});

export function countAttentionSignals(params: {
  selection: StarMapFilterSelection;
  sessionKeys?: StarMapSessionKeys;
  threads: readonly NavigationThreadSummary[];
}): StarMapAttentionCounts {
  const counts: StarMapAttentionCounts = { ...EMPTY_ATTENTION_COUNTS };
  const otherFacets = FACETS.filter((facet) => facet !== "attention");
  for (const thread of params.threads) {
    if (thread.archivedAt !== undefined) continue;
    const passesOthers = otherFacets.every((facet) =>
      passesFacet({
        facet,
        selection: params.selection,
        sessionKeys: params.sessionKeys,
        thread,
      }),
    );
    if (!passesOthers) continue;
    const categories = threadAttentionCategories(thread, params.sessionKeys);
    if (categories.includes("unread")) counts.unread += 1;
    if (categories.includes("active")) {
      if (isThreadRemoteWork(thread)) counts.activeRemote += 1;
      else counts.activeLocal += 1;
    }
  }
  return counts;
}

export function addAttentionCounts(
  left: StarMapAttentionCounts,
  right: StarMapAttentionCounts,
): StarMapAttentionCounts {
  return {
    activeLocal: left.activeLocal + right.activeLocal,
    activeRemote: left.activeRemote + right.activeRemote,
    unread: left.unread + right.unread,
  };
}

const FACETS: StarMapFilterFacet[] = ["attention", "pinned", "agent"];

/**
 * Built once. `passesFacet` runs per facet per thread, and counting runs
 * it again per chip, so rebuilding these arrays inside the loop churned
 * two allocations per call across a few thousand calls per snapshot.
 */
const FACET_KEYS: Record<StarMapFilterFacet, StarMapFilterKey[]> =
  Object.fromEntries(
    FACETS.map((facet) => [
      facet,
      STAR_MAP_FILTERS.filter((definition) => definition.facet === facet).map(
        (definition) => definition.key,
      ),
    ]),
  ) as Record<StarMapFilterFacet, StarMapFilterKey[]>;

function facetKeys(facet: StarMapFilterFacet): StarMapFilterKey[] {
  return FACET_KEYS[facet];
}

/**
 * Whether a thread survives one facet: it must match none of that facet's
 * excludes, and — when the facet has any includes at all — at least one of
 * them.
 */
function passesFacet(params: {
  facet: StarMapFilterFacet;
  selection: StarMapFilterSelection;
  sessionKeys?: StarMapSessionKeys;
  thread: NavigationThreadSummary;
}): boolean {
  let hasInclude = false;
  let matchedInclude = false;
  for (const key of facetKeys(params.facet)) {
    const state = filterState(params.selection, key);
    if (state === "neutral") continue;
    const matches = threadMatchesFilter(
      params.thread,
      key,
      params.sessionKeys,
    );
    if (state === "exclude") {
      if (matches) return false;
      continue;
    }
    hasInclude = true;
    if (matches) matchedInclude = true;
  }
  return hasInclude ? matchedInclude : true;
}

export function threadPassesFilters(params: {
  selection: StarMapFilterSelection;
  sessionKeys?: StarMapSessionKeys;
  thread: NavigationThreadSummary;
}): boolean {
  return FACETS.every((facet) =>
    passesFacet({
      facet,
      selection: params.selection,
      sessionKeys: params.sessionKeys,
      thread: params.thread,
    }),
  );
}

/**
 * Whether a pin keeps a thread on the map irrespective of the attention
 * chips. A pin is the operator saying "keep this in front of me", and the
 * sidebar's Pins section and the map are meant to agree — so the chips,
 * which describe transient attention, do not get to hide it.
 *
 * `pinned: exclude` is the one thing that still can: an operator asking to
 * see everything EXCEPT pins has said so explicitly, and a chip that
 * cannot act would be worse than no chip.
 */
function pinOverridesFilters(
  selection: StarMapFilterSelection,
  thread: NavigationThreadSummary,
): boolean {
  return (
    isPinnedThread(thread) && filterState(selection, "pinned") !== "exclude"
  );
}

/**
 * Threads to show: summoned threads first, then pinned threads in the
 * operator's own pin order, then everything else by recent activity.
 * Archived threads never surface on the map regardless of selection.
 *
 * Pins sort nearest the star deliberately — the slot closest to the body is
 * the one that stays put as the column grows, so a curated thread does not
 * wander as unrelated activity arrives.
 *
 * A summoned thread is one the operator named in the ⌘K palette, and it
 * outranks even a pin twice over: the chips do not get to hide it, and the
 * slot order puts it inside every per-cloud cap. Both matter for the same
 * reason — flying the camera to a card that the lens then declines to draw
 * is the failure the summon exists to prevent.
 */
export function selectFilteredThreads(params: {
  selection: StarMapFilterSelection;
  /** The owner already matched the complete metadata and assigned order. */
  ownerMatched?: boolean;
  sessionKeys?: StarMapSessionKeys;
  threads: readonly NavigationThreadSummary[];
  /** Identity keys the operator summoned from the ⌘K palette. */
  summonedKeys?: ReadonlySet<string>;
}): NavigationThreadSummary[] {
  // Guarded on the set being non-empty, which it is for every snapshot
  // until the operator uses ⌘K: this runs per comparison inside a sort that
  // itself runs per instance per navigation snapshot, and building an
  // identity key for a lookup that cannot match is a string allocation per
  // card per event for nothing.
  const summonedKeys =
    params.summonedKeys && params.summonedKeys.size > 0
      ? params.summonedKeys
      : undefined;
  const summoned = (thread: NavigationThreadSummary): boolean =>
    summonedKeys !== undefined
    && summonedKeys.has(buildThreadIdentityKey(thread.source, thread.id));
  return params.threads
    .filter((thread) => thread.archivedAt === undefined)
    .filter(
      (thread) =>
        params.ownerMatched
        || summoned(thread)
        || pinOverridesFilters(params.selection, thread)
        || threadPassesFilters({
          selection: params.selection,
          sessionKeys: params.sessionKeys,
          thread,
        }),
    )
    .sort((left, right) => {
      const leftSummoned = summoned(left);
      const rightSummoned = summoned(right);
      if (leftSummoned !== rightSummoned) return leftSummoned ? -1 : 1;
      const leftPinned = isPinnedThread(left);
      const rightPinned = isPinnedThread(right);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (leftPinned && rightPinned) return comparePinnedThreads(left, right);
      return params.ownerMatched ? 0 : (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    });
}

/**
 * How many threads each chip speaks for.
 *
 * Counted against the threads that already pass every *other* facet, so
 * the number answers "how many cards is this chip about right now" rather
 * than a global tally that ignores the rest of the selection.
 */
export function countFilterMatches(params: {
  selection: StarMapFilterSelection;
  sessionKeys?: StarMapSessionKeys;
  threads: readonly NavigationThreadSummary[];
}): Record<StarMapFilterKey, number> {
  const counts = Object.fromEntries(
    STAR_MAP_FILTERS.map((definition) => [definition.key, 0]),
  ) as Record<StarMapFilterKey, number>;

  for (const definition of STAR_MAP_FILTERS) {
    const otherFacets = FACETS.filter((facet) => facet !== definition.facet);
    for (const thread of params.threads) {
      if (thread.archivedAt !== undefined) continue;
      const passesOthers = otherFacets.every((facet) =>
        passesFacet({
          facet,
          selection: params.selection,
          sessionKeys: params.sessionKeys,
          thread,
        }),
      );
      if (!passesOthers) continue;
      if (threadMatchesFilter(thread, definition.key, params.sessionKeys)) {
        counts[definition.key] += 1;
      }
    }
  }
  return counts;
}

export function addFilterMatchCounts(
  left: Record<StarMapFilterKey, number>,
  right: Record<StarMapFilterKey, number>,
): Record<StarMapFilterKey, number> {
  return Object.fromEntries(
    STAR_MAP_FILTERS.map((definition) => [
      definition.key,
      left[definition.key] + right[definition.key],
    ]),
  ) as Record<StarMapFilterKey, number>;
}

const STORAGE_KEY = "pwragent.starMap.filterSelection";
/** Written by the pre-facet build; read once to carry a selection over. */
const LEGACY_CATEGORY_KEY = "pwragent.starMap.filters";
/** The agent chip used to live in view preferences as its own tri-state. */
const LEGACY_PREFERENCES_KEY = "pwragent.starMap.viewPreferences";

function legacyAgentSelection(): StarMapFilterState | undefined {
  try {
    const raw = window.localStorage.getItem(LEGACY_PREFERENCES_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { agentFilter?: unknown };
    if (parsed.agentFilter === "only") return "include";
    if (parsed.agentFilter === "none") return "exclude";
  } catch {
    return undefined;
  }
  return undefined;
}

function isFilterState(value: unknown): value is StarMapFilterState {
  return value === "neutral" || value === "include" || value === "exclude";
}

/**
 * The state a pre-merge `unread` / `active` pair carries forward, or
 * undefined when neither said anything.
 */
function mergeLegacyAttentionStates(
  values: readonly unknown[],
): StarMapFilterState | undefined {
  let result: StarMapFilterState | undefined;
  for (const value of values) {
    if (!isFilterState(value) || value === "neutral") continue;
    if (value === "include") return "include";
    result = value;
  }
  return result;
}

/**
 * Read the stored selection, migrating the pre-facet shape.
 *
 * The old model stored the set of ENABLED attention categories and started
 * with all of them on. "All on" and "all neutral" describe the same result,
 * so a full set migrates to an empty selection; a partial set was the
 * operator narrowing, which is exactly what includes now express.
 */
export function readStoredFilterSelection(): StarMapFilterSelection {
  if (typeof window === "undefined") return {};
  const selection: StarMapFilterSelection = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const definition of STAR_MAP_FILTERS) {
        const value = parsed[definition.key];
        if (isFilterState(value) && value !== "neutral") {
          selection[definition.key] = value;
        }
      }
      // `unread` and `active` were two chips before they became one, and
      // an operator who left either one on has a stored blob naming a key
      // that no longer exists. Reading it forward matters more than it
      // looks: dropping it silently would turn a narrowed map back into
      // an unfiltered one at the next launch, with nothing on screen to
      // say why. Include wins over exclude when the two disagree — the
      // combined chip cannot express "unread but not working", and
      // showing more than asked beats hiding what was asked for.
      const merged = mergeLegacyAttentionStates([
        parsed.unread,
        parsed.active,
      ]);
      if (merged && selection.attention === undefined) {
        selection.attention = merged;
      }
      return selection;
    }

    const legacyRaw = window.localStorage.getItem(LEGACY_CATEGORY_KEY);
    if (legacyRaw) {
      const enabled = JSON.parse(legacyRaw) as unknown;
      // The pre-facet blob stored the OLD category names, two of which
      // now share one chip, so it is read against those rather than
      // against today's keys.
      const legacyAttentionKeys = ["unread", "active", "approval", "pr", "unpushed"];
      if (
        Array.isArray(enabled)
        && enabled.length < legacyAttentionKeys.length
      ) {
        if (enabled.includes("unread") || enabled.includes("active")) {
          selection.attention = "include";
        }
        for (const key of ["approval", "pr", "unpushed"] as const) {
          if (enabled.includes(key)) selection[key] = "include";
        }
      }
    }
  } catch {
    return {};
  }
  const legacyAgent = legacyAgentSelection();
  if (legacyAgent) selection.agent = legacyAgent;
  return selection;
}

export function writeStoredFilterSelection(
  selection: StarMapFilterSelection,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Filter state is disposable; losing it is harmless.
  }
}
