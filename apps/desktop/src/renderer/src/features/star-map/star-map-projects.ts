import {
  buildThreadIdentityKey,
  classifyDirectory,
  type NavigationThreadSummary,
  type NavigationDirectoryRow,
} from "@pwragent/shared";

/** Presentation identity retained when a project pools multiple owners. */
export type StarMapProjectThread = NavigationThreadSummary & {
  starMapOwnerInstanceId: string;
};

export function projectThreadOwner(thread: NavigationThreadSummary): string | undefined {
  return "starMapOwnerInstanceId" in thread
    && typeof thread.starMapOwnerInstanceId === "string"
    ? thread.starMapOwnerInstanceId
    : undefined;
}

export function starMapThreadKey(thread: NavigationThreadSummary): string {
  const key = buildThreadIdentityKey(thread.source, thread.id);
  const owner = projectThreadOwner(thread);
  return owner === undefined ? key : `${owner}::${key}`;
}

/** One instance's directory behind a pooled project. */
export type StarMapProjectMember = {
  instanceId: string;
  /** That instance's OWN key for the directory: what its pages address. */
  directoryKey: string;
};

export type StarMapProject = {
  /** Stable identity across the fleet; see `starMapProjectIdentities`. */
  key: string;
  /**
   * The instances and directories pooled into this body.
   *
   * A project's key no longer names a directory anybody can open, so the
   * per-owner page resources are addressed through here. Empty when the
   * project came from threads alone, with no compact owner geometry.
   */
  members: StarMapProjectMember[];
  label: string;
  /** Most recent activity across every pooled thread. */
  lastActivityAt: number;
  /**
   * How strongly this project is pulled toward the galactic core. See
   * `projectMass`.
   */
  mass: number;
  /** Threads pooled from every instance, most recently active first. */
  threads: StarMapProjectThread[];
  /** Complete primary-membership count from compact owner geometry. */
  totalThreadCount?: number;
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

/** A folder name, folded for comparison. */
function projectNameKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * What a directory row pools under, fleet-wide.
 *
 * A directory is identified everywhere else in the app by its absolute
 * path, and a path names a checkout on ONE machine. This lens pools a
 * whole federation, so keying its bodies on the path drew the same
 * repository once per machine — three PwrSnaps, four PwrAgents — and
 * twice on a machine holding two clones of it.
 *
 * The thread list already answers this question and answers it by NAME:
 * `buildDirectorySummaries` groups a thread under its folder name, not
 * its path, and nobody looking at that list cares which root on which
 * drive a checkout sits under. This lens groups the same threads, so it
 * has to reach the same answer, and the rules below are what it takes to
 * get there across machines rather than within one:
 *
 * - A row whose owner could read a Git origin pools under that origin.
 *   It is the only part of a checkout that means the same thing
 *   everywhere, and the only thing that unifies a `PwrAgnt` folder here
 *   with a `PwrAgent` folder there.
 * - A row with no origin pools under its folder name — and if exactly
 *   one origin in the whole fleet is known by that name, it pools under
 *   THAT origin. This is the case the first cut got wrong and Harold saw
 *   on the map: one instance had read the remote and another had not, so
 *   the same project drew twice under the same name.
 * - Unless the name is ambiguous. Two origins known by one folder name
 *   are two projects, and an unversioned folder of that name could
 *   belong to either, so it pools by name with the other unversioned
 *   ones rather than guessing at an origin.
 *
 * The sentinel key for directory-less threads is already fleet-wide and
 * passes through untouched.
 */
function identityForRow(
  row: { key: string; name: string; origin?: string },
  originsByName: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  if (row.key === STAR_MAP_NO_PROJECT_KEY) return row.key;
  if (row.origin) return `repo:${row.origin}`;
  if (!row.name) return row.key;
  const origins = originsByName.get(row.name);
  if (origins && origins.size === 1) return `repo:${[...origins][0]}`;
  return `name:${row.name}`;
}

/**
 * Resolve one instance's directory key to the identity it pools under.
 *
 * Threads carry their owner's paths, so a thread is filed by asking the
 * instance that owns it what its directory is called everywhere else.
 * An unknown key — no compact geometry for that owner yet — stays itself,
 * which is the old per-path behaviour and the right thing to degrade to.
 *
 * Built over the WHOLE fleet rather than one row at a time, because
 * whether a folder name can stand in for an origin is a question about
 * every other row that shares that name.
 */
export function starMapProjectIdentities(
  descriptorsByInstance?: ReadonlyMap<string, readonly NavigationDirectoryRow[]>,
): (instanceId: string, directoryKey: string) => string {
  const rows: {
    instanceId: string;
    key: string;
    name: string;
    origin?: string;
  }[] = [];
  for (const [instanceId, descriptors] of descriptorsByInstance ?? []) {
    for (const descriptor of descriptors) {
      rows.push({
        instanceId,
        key: descriptor.key,
        name: projectNameKey(descriptor.label),
        origin: descriptor.repositoryKey,
      });
    }
  }
  const originsByName = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.origin || !row.name) continue;
    const origins = originsByName.get(row.name);
    if (origins) origins.add(row.origin);
    else originsByName.set(row.name, new Set([row.origin]));
  }
  const identities = new Map<string, string>();
  for (const row of rows) {
    identities.set(
      `${row.instanceId}\u0000${row.key}`,
      identityForRow(row, originsByName),
    );
  }
  return (instanceId, directoryKey) =>
    identities.get(`${instanceId}\u0000${directoryKey}`) ?? directoryKey;
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
  params?: {
    now?: number;
    descriptorsByInstance?: ReadonlyMap<string, readonly NavigationDirectoryRow[]>;
    /**
     * Identity keys the operator summoned from the ⌘K palette. A project
     * body caps how many cards it seats, and recency is the wrong tie-break
     * for a card that was asked for by name — so summoned threads sort to
     * the front of their project, inside the cap. The instance lenses get
     * the same guarantee from `selectFilteredThreads`; this lens re-sorts
     * its pools, so it has to be told again.
     */
    summonedKeys?: ReadonlySet<string>;
  },
): StarMapProject[] {
  const projects = new Map<string, StarMapProject>();
  const identityFor = starMapProjectIdentities(params?.descriptorsByInstance);
  /**
   * Folder names in the running, by member thread count.
   *
   * Merged members disagree about what the project is called — that is
   * the point when a `PwrAgnt` clone and a `PwrAgent` clone pool — so the
   * body wears the name the most work sits under, ties to the first
   * alphabetically so the map does not rename itself between renders.
   */
  const labels = new Map<string, Map<string, number>>();
  const nameProject = (identity: string, label: string, weight: number) => {
    const counts = labels.get(identity) ?? new Map<string, number>();
    counts.set(label, (counts.get(label) ?? 0) + weight);
    labels.set(identity, counts);
  };
  const owners = params?.descriptorsByInstance
    ? [...params.descriptorsByInstance.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )
    : [];
  for (const [instanceId, descriptors] of owners) {
    for (const descriptor of descriptors) {
      const identity = identityFor(instanceId, descriptor.key);
      nameProject(identity, descriptor.label, descriptor.counts.total);
      const existing = projects.get(identity);
      if (existing) {
        existing.members.push({ instanceId, directoryKey: descriptor.key });
        existing.totalThreadCount = (existing.totalThreadCount ?? 0) + descriptor.counts.total;
        existing.lastActivityAt = Math.max(existing.lastActivityAt, descriptor.latestUpdatedAt ?? 0);
      } else {
        projects.set(identity, { key: identity, label: descriptor.label,
          members: [{ instanceId, directoryKey: descriptor.key }],
          totalThreadCount: descriptor.counts.total, lastActivityAt: descriptor.latestUpdatedAt ?? 0,
          mass: 0, threads: [] });
      }
    }
  }
  const threadOwners = params?.descriptorsByInstance
    ? [...threadsByInstance.entries()].sort(([left], [right]) => left.localeCompare(right))
    : threadsByInstance.entries();
  for (const [instanceId, threads] of threadOwners) {
    for (const sourceThread of threads) {
      const thread: StarMapProjectThread = { ...sourceThread, starMapOwnerInstanceId: instanceId };
      const key = identityFor(instanceId, threadProjectKey(thread));
      const existing = projects.get(key);
      if (existing) {
        existing.threads.push(thread);
      } else {
        const label = key === STAR_MAP_NO_PROJECT_KEY
          ? NO_PROJECT_LABEL
          : threadProjectLabel(thread);
        nameProject(key, label, 1);
        projects.set(key, {
          key,
          members: [],
          label,
          lastActivityAt: thread.updatedAt ?? 0,
          mass: 0,
          threads: [thread],
        });
      }
    }
  }
  const now = params?.now ?? Date.now();
  // Non-empty check first: see the same guard in `selectFilteredThreads`.
  const summonedKeys =
    params?.summonedKeys && params.summonedKeys.size > 0
      ? params.summonedKeys
      : undefined;
  const summoned = (thread: NavigationThreadSummary): boolean =>
    summonedKeys !== undefined
    && summonedKeys.has(buildThreadIdentityKey(thread.source, thread.id));
  for (const project of projects.values()) {
    const counts = labels.get(project.key);
    if (counts) {
      project.label = [...counts].sort(
        ([leftLabel, left], [rightLabel, right]) =>
          right - left || leftLabel.localeCompare(rightLabel),
      )[0][0];
    }
    project.threads.sort((left, right) => {
      const leftSummoned = summoned(left);
      const rightSummoned = summoned(right);
      if (leftSummoned !== rightSummoned) return leftSummoned ? -1 : 1;
      return params?.descriptorsByInstance ? 0 : (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    });
    if (project.totalThreadCount === undefined) project.lastActivityAt = project.threads.reduce(
      (latest, thread) => Math.max(latest, thread.updatedAt ?? 0),
      0,
    );
    project.mass = projectMass({
      cardCount: project.totalThreadCount ?? project.threads.length,
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

