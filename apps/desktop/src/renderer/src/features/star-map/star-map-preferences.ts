import type { PrSummary } from "@pwragent/shared";

/**
 * Per-operator view preferences for the Star Map. These are viewing
 * state, not configuration — they live in localStorage rather than
 * config.toml so two windows can look at the fleet differently.
 */
export type StarMapCardFields = {
  /** Backend/provider chip ("OpenAI"). */
  provider: boolean;
  /** Git branch chip. */
  branch: boolean;
  /** First linked directory — the project the thread is about. */
  primaryDirectory: boolean;
  /** Any additional linked directories. */
  secondaryDirectories: boolean;
  /** Merged/closed PRs. Off means open pull requests only. */
  terminalPullRequests: boolean;
};

export type StarMapLayoutMode = "lanes" | "orbit" | "projects";

export type StarMapViewPreferences = {
  /**
   * Lane columns under a body row, instance bodies with orbiting card
   * rings, or projects as galactic cores with their threads pooled from
   * every instance.
   */
  layout: StarMapLayoutMode;
  cardFields: StarMapCardFields;
  /** Drop instances that are not currently connected from the map. */
  hideOfflineInstances: boolean;
};

/**
 * Title, primary directory and open PRs — the "what do I need to review"
 * signal. Everything else is available but off by default so a card stays
 * scannable at a glance.
 */
export const DEFAULT_STAR_MAP_PREFERENCES: StarMapViewPreferences = {
  /**
   * Orbit, not lanes. Lanes were the first layout and read as a list of
   * columns; orbit is the one that shows the fleet as a fleet, which is
   * what the map is for. An explicitly chosen layout is stored and wins;
   * an operator who never touched the view options has no stored choice
   * and rides this default — including across upgrades, so flipping it
   * moves them too, not only fresh installs.
   */
  layout: "orbit",
  cardFields: {
    provider: false,
    branch: false,
    primaryDirectory: true,
    secondaryDirectories: false,
    terminalPullRequests: false,
  },
  hideOfflineInstances: false,
};

export const STAR_MAP_CARD_FIELD_LABELS: Record<
  keyof StarMapCardFields,
  string
> = {
  provider: "Provider",
  branch: "Branch name",
  primaryDirectory: "Project",
  secondaryDirectories: "Other directories",
  terminalPullRequests: "Merged / closed PRs",
};

const STORAGE_KEY = "pwragent.starMap.viewPreferences";

export function readStoredPreferences(): StarMapViewPreferences {
  if (typeof window === "undefined") return DEFAULT_STAR_MAP_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STAR_MAP_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<StarMapViewPreferences>;
    return {
      // Every recognized layout is accepted verbatim; anything else —
      // including a blob from before `layout` existed — falls back to
      // the SAME default a fresh profile gets, so "the default lens"
      // has exactly one definition in this module.
      layout:
        parsed.layout === "lanes"
        || parsed.layout === "orbit"
        || parsed.layout === "projects"
          ? parsed.layout
          : DEFAULT_STAR_MAP_PREFERENCES.layout,
      cardFields: {
        ...DEFAULT_STAR_MAP_PREFERENCES.cardFields,
        ...(parsed.cardFields ?? {}),
      },
      hideOfflineInstances:
        parsed.hideOfflineInstances
        ?? DEFAULT_STAR_MAP_PREFERENCES.hideOfflineInstances,
    };
  } catch {
    return DEFAULT_STAR_MAP_PREFERENCES;
  }
}

export function writeStoredPreferences(value: StarMapViewPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // View preferences are disposable; losing them is harmless.
  }
}

/** A pull request that still wants attention (not merged, not closed). */
export function isOpenPullRequest(pr: PrSummary): boolean {
  return (
    pr.state !== "merged"
    && pr.state !== "closed"
    && pr.lifecycleState !== "merged"
    && pr.lifecycleState !== "closed"
  );
}

export function visiblePullRequests(
  prs: readonly PrSummary[] | undefined,
  fields: StarMapCardFields,
): PrSummary[] {
  if (!prs) return [];
  return fields.terminalPullRequests ? [...prs] : prs.filter(isOpenPullRequest);
}
