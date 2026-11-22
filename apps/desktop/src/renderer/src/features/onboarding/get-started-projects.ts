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

function compareAgents(left: RecentProjectAgent, right: RecentProjectAgent): number {
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Today", "Yesterday", "4 days ago", "3 weeks ago", "5 months ago". */
export function projectRecencyLabel(lastActiveAt: number | undefined, now: number): string | undefined {
  if (lastActiveAt === undefined) return undefined;
  const age = Math.max(0, now - lastActiveAt);
  if (age < DAY) return "Today";
  const days = Math.floor(age / DAY);
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
