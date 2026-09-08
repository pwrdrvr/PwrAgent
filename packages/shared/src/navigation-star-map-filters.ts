import type {
  NavigationStarMapFacetCounts,
  NavigationStarMapFilterKey,
  NavigationStarMapFilterSelection,
} from "./contracts/navigation";

export const NAVIGATION_STAR_MAP_FACETS = {
  attention: ["attention", "approval", "pr", "unpushed"],
  pinned: ["pinned"],
  agent: ["agent"],
} as const;
export type NavigationStarMapSignals = Record<NavigationStarMapFilterKey, boolean> & {
  active: boolean;
  unread: boolean;
};

/** Includes OR within a facet and AND across facets; exclusions always veto. */
export function passesNavigationStarMapFilters(
  signals: NavigationStarMapSignals,
  selection: NavigationStarMapFilterSelection,
  exceptFacet?: keyof typeof NAVIGATION_STAR_MAP_FACETS,
): boolean {
  for (const [facet, keys] of Object.entries(NAVIGATION_STAR_MAP_FACETS)) {
    if (facet === exceptFacet) continue;
    let hasInclude = false;
    let matchedInclude = false;
    for (const key of keys) {
      if (selection[key] === "exclude" && signals[key]) return false;
      if (selection[key] === "include") {
        hasInclude = true;
        matchedInclude ||= signals[key];
      }
    }
    if (hasInclude && !matchedInclude) return false;
  }
  return true;
}

/** Counts ignore their own facet, matching what toggling that chip can reveal. */
export function countNavigationStarMapFacets(
  signals: Iterable<NavigationStarMapSignals>,
  selection: NavigationStarMapFilterSelection,
): NavigationStarMapFacetCounts {
  const counts: NavigationStarMapFacetCounts = {
    matches: { attention: 0, approval: 0, pr: 0, unpushed: 0, pinned: 0, agent: 0 },
    active: 0,
    unread: 0,
  };
  for (const signal of signals) {
    for (const [facet, keys] of Object.entries(NAVIGATION_STAR_MAP_FACETS)) {
      if (!passesNavigationStarMapFilters(signal, selection, facet as keyof typeof NAVIGATION_STAR_MAP_FACETS)) continue;
      for (const key of keys) if (signal[key]) counts.matches[key] += 1;
      if (facet === "attention") {
        if (signal.active) counts.active += 1;
        if (signal.unread) counts.unread += 1;
      }
    }
  }
  return counts;
}
