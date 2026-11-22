import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DiscoverRecentProjectsResponse,
  RecentProjectAgent,
  RecentProjectObservation,
  RecentProjectSourceReport,
} from "@pwragent/shared/contracts/settings";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";

/** Codex is read newest first, one page at a time, up to this budget. */
export const RECENT_PROJECT_CODEX_PAGE_SIZE = 100;
export const RECENT_PROJECT_CODEX_MAX_PAGES = 3;
/**
 * Folders are resolved newest first until this many distinct projects are
 * found. Deleted folders and extra worktrees of one repository do not count.
 */
export const RECENT_PROJECT_MAX_PROJECTS = 60;
/** At most this many folders are checked against the disk and Git. */
export const RECENT_PROJECT_MAX_FOLDERS = 200;
const RESOLVE_CONCURRENCY = 6;

export type RecentCodexDirectories = {
  directories: Array<{ cwd: string; updatedAt?: number }>;
  complete: boolean;
};

export type RecentProjectDiscoveryDeps = {
  /** False when the profile being set up has its own Codex login. */
  includeCodex: boolean;
  /**
   * Reads Codex's `thread/list` through the App Server protocol. Undefined
   * when no Codex is set up, which the agent rows already say.
   */
  readCodexDirectories?: () => Promise<RecentCodexDirectories>;
  /**
   * Claude Code and ACP threads from PwrAgent's own lists. Undefined in the
   * bootstrap profile, which serves no thread data and has none of its own.
   */
  listPwrAgentThreads?: () => Promise<AppServerThreadSummary[]>;
  labelFor: (agent: RecentProjectAgent) => string;
  /** The project root a folder registers as, or undefined when it is gone. */
  resolveProjectRoot: (path: string) => Promise<string | undefined>;
};

type RawObservation = { cwd: string; agent: RecentProjectAgent; lastActiveAt?: number };

/**
 * Recent project folders for Get started, with how each agent's read went.
 * Nothing here reads an agent's own storage: Codex answers through its
 * protocol, and Claude Code and ACP agents through PwrAgent's thread lists.
 * Ranking, prechecking and merging the same folder from two agents happen
 * in the renderer (`get-started-projects.ts`).
 */
export async function discoverRecentProjects(
  deps: RecentProjectDiscoveryDeps,
): Promise<DiscoverRecentProjectsResponse> {
  const sources: RecentProjectSourceReport[] = [];
  const raw: RawObservation[] = [];

  const [codexRead, pwrAgentRead] = await Promise.allSettled([
    deps.includeCodex && deps.readCodexDirectories ? deps.readCodexDirectories() : undefined,
    deps.listPwrAgentThreads?.(),
  ]);

  const codexLabel = deps.labelFor("codex");
  if (!deps.includeCodex) {
    sources.push({
      agent: "codex",
      label: codexLabel,
      status: "skipped",
      detail: "This profile signs in to Codex on its own.",
    });
  } else if (!deps.readCodexDirectories) {
    sources.push({ agent: "codex", label: codexLabel, status: "skipped" });
  } else if (codexRead.status === "rejected") {
    sources.push({ agent: "codex", label: codexLabel, status: "failed", detail: errorText(codexRead.reason) });
  } else if (codexRead.value) {
    for (const directory of codexRead.value.directories) {
      raw.push({ cwd: directory.cwd, agent: "codex", lastActiveAt: directory.updatedAt });
    }
    const budget = RECENT_PROJECT_CODEX_PAGE_SIZE * RECENT_PROJECT_CODEX_MAX_PAGES;
    sources.push(codexRead.value.complete
      ? { agent: "codex", label: codexLabel, status: "complete" }
      : {
        agent: "codex",
        label: codexLabel,
        status: "partial",
        detail: `Read the ${budget} most recent threads. Older projects may be missing.`,
      });
  }

  if (deps.listPwrAgentThreads) {
    if (pwrAgentRead.status === "rejected") {
      sources.push({
        agent: "claude",
        label: deps.labelFor("claude"),
        status: "failed",
        detail: errorText(pwrAgentRead.reason),
      });
    } else {
      const seen = new Set<RecentProjectAgent>();
      for (const thread of pwrAgentRead.value ?? []) {
        // Codex is read above, from the login this profile will use.
        if (thread.source === "codex" || thread.archivedAt !== undefined) continue;
        const cwd = threadFolder(thread);
        if (!cwd) continue;
        seen.add(thread.source);
        raw.push({ cwd, agent: thread.source, lastActiveAt: thread.updatedAt ?? thread.createdAt });
      }
      for (const agent of seen) {
        sources.push({ agent, label: deps.labelFor(agent), status: "complete" });
      }
    }
  }

  const { observations, droppedAgents, probed } = await resolveObservations(raw, deps.resolveProjectRoot);
  for (const agent of droppedAgents) {
    const existing = sources.find((source) => source.agent === agent);
    if (existing && existing.status === "complete") {
      existing.status = "partial";
      existing.detail = `Checked the ${probed} most recent folders. Older projects may be missing.`;
    }
  }
  return { sources, observations };
}

function threadFolder(thread: AppServerThreadSummary): string | undefined {
  const projectKey = thread.projectKey?.trim();
  if (projectKey) return projectKey;
  return thread.linkedDirectories.find((directory) => directory.path?.trim())?.path?.trim();
}

/**
 * Resolves distinct folders to project roots, newest first, until
 * `RECENT_PROJECT_MAX_PROJECTS` roots are found or `RECENT_PROJECT_MAX_FOLDERS`
 * folders are checked. A folder that no longer exists is left out. Returns
 * one observation per (root, agent) at its newest time, and the agents with
 * a folder that was never checked.
 */
async function resolveObservations(
  raw: readonly RawObservation[],
  resolveProjectRoot: (path: string) => Promise<string | undefined>,
): Promise<{
  observations: RecentProjectObservation[];
  droppedAgents: Set<RecentProjectAgent>;
  probed: number;
}> {
  const newestByFolder = new Map<string, { cwd: string; newest: number }>();
  for (const observation of raw) {
    const key = canonicalizeNavigationPath(observation.cwd);
    if (!key) continue;
    const time = observation.lastActiveAt ?? Number.NEGATIVE_INFINITY;
    const existing = newestByFolder.get(key);
    if (!existing || time > existing.newest) newestByFolder.set(key, { cwd: observation.cwd, newest: time });
  }
  const ordered = [...newestByFolder.entries()]
    .sort(([leftKey, left], [rightKey, right]) => right.newest - left.newest || leftKey.localeCompare(rightKey));

  const roots = new Map<string, string | undefined>();
  const distinctRoots = new Set<string>();
  /** Folders whose project was never listed: unchecked, or past the cap. */
  const droppedKeys = new Set<string>();
  let probed = 0;
  // Batches keep the newest-first order: a later batch starts only while
  // fewer than the cap of projects has been found.
  while (probed < ordered.length && probed < RECENT_PROJECT_MAX_FOLDERS && distinctRoots.size < RECENT_PROJECT_MAX_PROJECTS) {
    const batch = ordered.slice(probed, Math.min(probed + RESOLVE_CONCURRENCY, RECENT_PROJECT_MAX_FOLDERS));
    probed += batch.length;
    const resolved = await Promise.all(batch.map(async ([, { cwd }]) => await resolveProjectRoot(cwd).catch(() => undefined)));
    for (const [index, [key]] of batch.entries()) {
      const root = resolved[index];
      // A batch can cross the cap; the newest roots in it are kept.
      if (root && !distinctRoots.has(root) && distinctRoots.size >= RECENT_PROJECT_MAX_PROJECTS) {
        droppedKeys.add(key);
        continue;
      }
      roots.set(key, root);
      if (root) distinctRoots.add(root);
    }
  }

  for (const [key] of ordered.slice(probed)) droppedKeys.add(key);

  const droppedAgents = new Set<RecentProjectAgent>();
  const byRootAndAgent = new Map<string, RecentProjectObservation>();
  for (const observation of raw) {
    const key = canonicalizeNavigationPath(observation.cwd);
    if (!key) continue;
    if (droppedKeys.has(key)) {
      droppedAgents.add(observation.agent);
      continue;
    }
    const root = roots.get(key);
    if (!root) continue;
    const id = JSON.stringify([observation.agent, root]);
    const existing = byRootAndAgent.get(id);
    if (
      !existing
      || (observation.lastActiveAt ?? Number.NEGATIVE_INFINITY) > (existing.lastActiveAt ?? Number.NEGATIVE_INFINITY)
    ) {
      byRootAndAgent.set(id, {
        path: root,
        agent: observation.agent,
        ...(observation.lastActiveAt === undefined ? {} : { lastActiveAt: observation.lastActiveAt }),
      });
    }
  }
  return { observations: [...byRootAndAgent.values()], droppedAgents, probed };
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
