import type {
  RecentProjectAgent,
  RecentProjectObservation,
  RecentProjectSourceReport,
} from "@pwragent/shared/contracts/settings";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";

/**
 * Get started's Projects section, as rules:
 *
 * - One row per folder. The same folder reported by two agents, or spelled
 *   with a trailing slash or backslashes, is one row naming both agents.
 * - Rows rank by their newest use by any agent, newest first. A folder no
 *   agent dated ranks last. Ties break by path, so the order never depends
 *   on which agent answered first.
 * - The first `PRECHECKED_PROJECT_COUNT` rows start checked and show; the
 *   rest start unchecked behind Review all. A row the operator toggles keeps
 *   that choice, whatever its rank.
 * - The list fills in as each part of the search answers. A row already
 *   listed keeps the state it showed when another answer adds rows, so an
 *   answer never checks or unchecks a row the operator has seen. Added rows
 *   start by the rule above.
 */
export const PRECHECKED_PROJECT_COUNT = 12;

export type ProjectCandidate = {
  /** Identity across agents and spellings. */
  key: string;
  path: string;
  label: string;
  lastActiveAt?: number;
  /** Every agent that used the folder, in a fixed order. */
  agents: RecentProjectAgent[];
  /** Position in the ranking, from 0. */
  rank: number;
};

export function projectKey(path: string): string {
  return canonicalizeNavigationPath(path.trim());
}

function folderLabel(path: string): string {
  const parts = canonicalizeNavigationPath(path).split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function agentOrder(agent: RecentProjectAgent): number {
  return agent === "codex" ? 0 : agent === "claude" ? 1 : 2;
}

/** Codex, then Claude Code, then other agents by name. */
export function compareAgents(left: RecentProjectAgent, right: RecentProjectAgent): number {
  return agentOrder(left) - agentOrder(right) || left.localeCompare(right);
}

export function rankProjectCandidates(
  observations: readonly RecentProjectObservation[],
): ProjectCandidate[] {
  const byKey = new Map<string, {
    key: string;
    path: string;
    lastActiveAt?: number;
    agents: Set<RecentProjectAgent>;
  }>();
  for (const observation of observations) {
    const key = projectKey(observation.path);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        path: key,
        lastActiveAt: observation.lastActiveAt,
        agents: new Set([observation.agent]),
      });
      continue;
    }
    existing.agents.add(observation.agent);
    if (
      observation.lastActiveAt !== undefined
      && (existing.lastActiveAt === undefined || observation.lastActiveAt > existing.lastActiveAt)
    ) {
      existing.lastActiveAt = observation.lastActiveAt;
    }
  }
  return [...byKey.values()]
    .sort((left, right) => (right.lastActiveAt ?? Number.NEGATIVE_INFINITY)
      - (left.lastActiveAt ?? Number.NEGATIVE_INFINITY)
      || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry, rank) => ({
      key: entry.key,
      path: entry.path,
      label: folderLabel(entry.path),
      ...(entry.lastActiveAt === undefined ? {} : { lastActiveAt: entry.lastActiveAt }),
      agents: [...entry.agents].sort(compareAgents),
      rank,
    }));
}

/** Toggles the operator made, by candidate key. */
export type ProjectChoices = ReadonlyMap<string, boolean>;

export function isProjectChecked(candidate: ProjectCandidate, choices: ProjectChoices): boolean {
  return choices.get(candidate.key) ?? candidate.rank < PRECHECKED_PROJECT_COUNT;
}

/**
 * `choices` plus the state each listed row shows now, for rows the operator
 * has not toggled. Apply it when another answer is about to re-rank the list.
 */
export function keepListedChoices(
  listed: readonly ProjectCandidate[],
  choices: ProjectChoices,
): ProjectChoices {
  const next = new Map(choices);
  for (const candidate of listed) {
    if (!next.has(candidate.key)) next.set(candidate.key, isProjectChecked(candidate, choices));
  }
  return next;
}

export function checkedProjectPaths(
  candidates: readonly ProjectCandidate[],
  choices: ProjectChoices,
): string[] {
  return candidates.filter((candidate) => isProjectChecked(candidate, choices))
    .map((candidate) => candidate.path);
}

/** The rows shown before Review all, and the rows it reveals. */
export function splitProjectCandidates(
  candidates: readonly ProjectCandidate[],
): { shown: ProjectCandidate[]; collapsed: ProjectCandidate[] } {
  return {
    shown: candidates.slice(0, PRECHECKED_PROJECT_COUNT),
    collapsed: candidates.slice(PRECHECKED_PROJECT_COUNT),
  };
}

export type ProjectScanNotice = { agent: RecentProjectAgent; text: string; tone: "partial" | "failed" };

/** Reads worth a line: one that stopped early, or one that could not run. */
export function projectScanNotices(
  sources: readonly RecentProjectSourceReport[],
): ProjectScanNotice[] {
  return sources.flatMap((source): ProjectScanNotice[] => {
    if (source.status === "partial") {
      return [{
        agent: source.agent,
        tone: "partial",
        text: `${source.label}: ${source.detail ?? "Read only part of the history. Older projects may be missing."}`,
      }];
    }
    if (source.status === "failed") {
      return [{
        agent: source.agent,
        tone: "failed",
        text: `${source.label} couldn't be read${source.detail ? `: ${source.detail}` : "."}`,
      }];
    }
    return [];
  });
}

const DAY = 24 * 60 * 60 * 1000;

function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * "Today", "Yesterday", "4 days ago", "3 weeks ago", "5 months ago", by the
 * local calendar day, not by 24-hour spans.
 */
export function projectRecencyLabel(lastActiveAt: number | undefined, now: number): string | undefined {
  if (lastActiveAt === undefined) return undefined;
  // Rounding absorbs the 23- and 25-hour days of a daylight-saving change.
  const days = Math.max(0, Math.round((startOfLocalDay(now) - startOfLocalDay(lastActiveAt)) / DAY));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
