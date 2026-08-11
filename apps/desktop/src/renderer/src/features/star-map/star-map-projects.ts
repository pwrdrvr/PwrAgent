import {
  buildThreadIdentityKey,
  classifyDirectory,
  type NavigationThreadSummary,
} from "@pwragent/shared";

export type StarMapProject = {
  /** Stable identity: the repo root path, or a sentinel when there is none. */
  key: string;
  label: string;
  /** Most recent activity across every pooled thread. */
  lastActivityAt: number;
  /**
   * How strongly this project is pulled toward the galactic core. See
   * `projectMass`.
   */
  mass: number;
  /** Threads pooled from every instance, most recently active first. */
  threads: NavigationThreadSummary[];
};

/**
 * Freshness is worth this many threads of pull at its strongest.
 *
 * A project touched in the last hour is dragged inward as if it carried
 * this many extra cards, so a small live project can out-rank a big
 * dormant one — but a genuinely large project still wins on volume alone.
 */
const RECENCY_MASS = 5;
/** Activity this old contributes half of `RECENCY_MASS`. */
const RECENCY_HALF_LIFE_MS = 12 * 60 * 60 * 1000;

/**
 * A project's gravitational mass: how much work it represents, and how
 * live that work is.
 *
 * Heavy projects seat near the core because the core is where the least
 * travel is — reviewing everything in a dense project costs less when it
 * is central. Dormant one-thread projects drift to the rim, which is
 * where you want them: still on the map, out of the way.
 */
export function projectMass(params: {
  cardCount: number;
  lastActivityAt: number;
  now: number;
}): number {
  const age = Math.max(0, params.now - params.lastActivityAt);
  const freshness = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
  return params.cardCount + RECENCY_MASS * freshness;
}

/** Threads with no linked directory still need somewhere to live. */
export const STAR_MAP_NO_PROJECT_KEY = "__no-project__";
const NO_PROJECT_LABEL = "No project";

/**
 * A thread's project is whatever directory row the Directories lens would
 * file its primary linked directory under, via the shared classifier:
 * worktrees collapse onto their repo root, and every scratch checkout
 * collapses into ONE "Workspaces" project. Grouping on the raw path
 * instead gave each hash-named scratch dir its own one-thread body.
 */
export function threadProjectKey(thread: NavigationThreadSummary): string {
  const primary = thread.linkedDirectories[0];
  return primary ? classifyDirectory(primary).key : STAR_MAP_NO_PROJECT_KEY;
}

/** Display label for a thread's project; shared with the cluster layout. */
export function threadProjectLabel(thread: NavigationThreadSummary): string {
  const primary = thread.linkedDirectories[0];
  if (!primary) return NO_PROJECT_LABEL;
  const descriptor = classifyDirectory(primary);
  // A label the classifier computed itself ("Workspaces", "Codex Chats",
  // a worktree collapsed onto its repo) is canonical — keep it. When it
  // just echoed the directory's own label, prefer the repo folder name:
  // worktree labels are generated per-workspace, and a cloud named
  // "2026-07-31-b3ba9c" is the spreadsheet this lens is escaping.
  if (descriptor.label !== primary.label) return descriptor.label;
  const path = descriptor.path ?? primary.path;
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? descriptor.label;
}

/**
 * Pool threads from every instance into projects.
 *
 * Unlike the instance layouts, a project body deliberately mixes threads
 * from different machines — that is the whole point of the lens: "this
 * project, everywhere" rather than "this machine, everything".
 */
export function groupThreadsByProject(
  threadsByInstance: ReadonlyMap<string, readonly NavigationThreadSummary[]>,
  params?: { now?: number },
): StarMapProject[] {
  const projects = new Map<string, StarMapProject>();
  for (const threads of threadsByInstance.values()) {
    for (const thread of threads) {
      const key = threadProjectKey(thread);
      const existing = projects.get(key);
      if (existing) {
        existing.threads.push(thread);
      } else {
        projects.set(key, {
          key,
          label: key === STAR_MAP_NO_PROJECT_KEY
            ? NO_PROJECT_LABEL
            : threadProjectLabel(thread),
          lastActivityAt: thread.updatedAt ?? 0,
          mass: 0,
          threads: [thread],
        });
      }
    }
  }
  const now = params?.now ?? Date.now();
  for (const project of projects.values()) {
    project.threads.sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
    project.lastActivityAt = project.threads.reduce(
      (latest, thread) => Math.max(latest, thread.updatedAt ?? 0),
      0,
    );
    project.mass = projectMass({
      cardCount: project.threads.length,
      lastActivityAt: project.lastActivityAt,
      now,
    });
  }
  // Heaviest first so the layout seats them nearest the core; ties break
  // on label so the map does not reshuffle between renders.
  return [...projects.values()].sort(
    (left, right) =>
      right.mass - left.mass || left.label.localeCompare(right.label),
  );
}

/**
 * Owning instance per thread, for the card's instance chip.
 *
 * Built once and looked up by identity key rather than scanned per card:
 * a per-card scan is O(instances x threads) on every render, and matching
 * on object identity would break silently the moment any layer cloned a
 * summary instead of passing the same reference through.
 */
export function instanceIdByThreadKey(
  threadsByInstance: ReadonlyMap<string, readonly NavigationThreadSummary[]>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [instanceId, threads] of threadsByInstance) {
    for (const thread of threads) {
      owners.set(buildThreadIdentityKey(thread.source, thread.id), instanceId);
    }
  }
  return owners;
}
