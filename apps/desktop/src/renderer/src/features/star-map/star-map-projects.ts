import type { NavigationThreadSummary } from "@pwragent/shared";

export type StarMapProject = {
  /** Stable identity: the repo root path, or a sentinel when there is none. */
  key: string;
  label: string;
  /** Threads pooled from every instance, most recently active first. */
  threads: NavigationThreadSummary[];
};

/** Threads with no linked directory still need somewhere to live. */
export const STAR_MAP_NO_PROJECT_KEY = "__no-project__";
const NO_PROJECT_LABEL = "No project";

/**
 * A thread's project is the repo its primary linked directory belongs to.
 *
 * `path` is the repo root even for worktree entries (which carry the
 * worktree separately in `worktreePath`), so grouping on it collapses
 * every worktree of a repo onto one body. Grouping on the label instead
 * would scatter a repo across a body per worktree, since worktree labels
 * are generated per-workspace.
 */
export function threadProjectKey(thread: NavigationThreadSummary): string {
  const primary = thread.linkedDirectories[0];
  return primary?.path ?? STAR_MAP_NO_PROJECT_KEY;
}

function projectLabel(thread: NavigationThreadSummary): string {
  const primary = thread.linkedDirectories[0];
  if (!primary) return NO_PROJECT_LABEL;
  // Prefer the repo folder name over a worktree-generated label.
  const segments = primary.path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? primary.label;
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
            : projectLabel(thread),
          threads: [thread],
        });
      }
    }
  }
  for (const project of projects.values()) {
    project.threads.sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
  }
  // Busiest projects first so the layout seats them nearest the centre;
  // ties break on label so the map does not reshuffle between renders.
  return [...projects.values()].sort(
    (left, right) =>
      right.threads.length - left.threads.length
      || left.label.localeCompare(right.label),
  );
}

/** Which instance a thread lives on, for the card's instance chip. */
export function instanceIdForThread(
  threadsByInstance: ReadonlyMap<string, readonly NavigationThreadSummary[]>,
  thread: NavigationThreadSummary,
): string | undefined {
  for (const [instanceId, threads] of threadsByInstance) {
    if (threads.some((entry) => entry === thread)) return instanceId;
  }
  return undefined;
}
