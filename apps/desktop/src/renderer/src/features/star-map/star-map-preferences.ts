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

export type StarMapLayoutMode = "lanes" | "orbit";

/**
 * Include everything, only agent-driven threads, or everything except
 * them. Unlike the attention categories this narrows the result rather
 * than widening it, so it is a cycle rather than a toggle.
 */
export type StarMapAgentFilter = "all" | "only" | "none";

export const STAR_MAP_AGENT_FILTER_ORDER: readonly StarMapAgentFilter[] = [
  "all",
  "only",
  "none",
];

export const STAR_MAP_AGENT_FILTER_LABELS: Record<StarMapAgentFilter, string> =
  {
    all: "Agents: all",
    only: "Agents only",
    none: "Agents hidden",
  };

export function nextAgentFilter(
  current: StarMapAgentFilter,
): StarMapAgentFilter {
  const index = STAR_MAP_AGENT_FILTER_ORDER.indexOf(current);
  return STAR_MAP_AGENT_FILTER_ORDER[
    (index + 1) % STAR_MAP_AGENT_FILTER_ORDER.length
  ];
}

export type StarMapViewPreferences = {
  /** Lane columns under a body row, or bodies with orbiting card rings. */
  layout: StarMapLayoutMode;
  cardFields: StarMapCardFields;
  /** Drop instances that are not currently connected from the map. */
  hideOfflineInstances: boolean;
  /** Include agent-driven threads, show only those, or hide them. */
  agentFilter: StarMapAgentFilter;
};

/**
 * Title, primary directory and open PRs — the "what do I need to review"
 * signal. Everything else is available but off by default so a card stays
 * scannable at a glance.
 */
export const DEFAULT_STAR_MAP_PREFERENCES: StarMapViewPreferences = {
  layout: "lanes",
  cardFields: {
    provider: false,
    branch: false,
    primaryDirectory: true,
    secondaryDirectories: false,
    terminalPullRequests: false,
  },
  hideOfflineInstances: false,
  agentFilter: "all",
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
      layout: parsed.layout === "orbit" ? "orbit" : "lanes",
      cardFields: {
        ...DEFAULT_STAR_MAP_PREFERENCES.cardFields,
        ...(parsed.cardFields ?? {}),
      },
      hideOfflineInstances:
        parsed.hideOfflineInstances
        ?? DEFAULT_STAR_MAP_PREFERENCES.hideOfflineInstances,
      agentFilter: STAR_MAP_AGENT_FILTER_ORDER.includes(
        parsed.agentFilter as StarMapAgentFilter,
      )
        ? (parsed.agentFilter as StarMapAgentFilter)
        : DEFAULT_STAR_MAP_PREFERENCES.agentFilter,
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
