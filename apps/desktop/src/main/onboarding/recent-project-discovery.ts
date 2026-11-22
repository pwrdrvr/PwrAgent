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
/** Distinct folders checked against the disk and Git, newest first. */
export const RECENT_PROJECT_MAX_FOLDERS = 60;
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

  const { observations, droppedAgents } = await resolveObservations(raw, deps.resolveProjectRoot);
  for (const agent of droppedAgents) {
    const existing = sources.find((source) => source.agent === agent);
    if (existing && existing.status === "complete") {
      existing.status = "partial";
      existing.detail = `Checked the ${RECENT_PROJECT_MAX_FOLDERS} most recent folders. Older projects may be missing.`;
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
 * Resolves the newest distinct folders to project roots, at most
 * `RECENT_PROJECT_MAX_FOLDERS` of them. A folder that no longer exists is
 * left out. Returns one observation per (root, agent) at its newest time.
 */
async function resolveObservations(
  raw: readonly RawObservation[],
  resolveProjectRoot: (path: string) => Promise<string | undefined>,
): Promise<{ observations: RecentProjectObservation[]; droppedAgents: Set<RecentProjectAgent> }> {
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
  const kept = ordered.slice(0, RECENT_PROJECT_MAX_FOLDERS);
  const keptKeys = new Set(kept.map(([key]) => key));
  const droppedAgents = new Set<RecentProjectAgent>();
  for (const observation of raw) {
    if (!keptKeys.has(canonicalizeNavigationPath(observation.cwd))) droppedAgents.add(observation.agent);
  }

  const roots = new Map<string, string | undefined>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < kept.length) {
      const [key, { cwd }] = kept[next]!;
      next += 1;
      roots.set(key, await resolveProjectRoot(cwd).catch(() => undefined));
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, kept.length) }, worker));

  const byRootAndAgent = new Map<string, RecentProjectObservation>();
  for (const observation of raw) {
    const root = roots.get(canonicalizeNavigationPath(observation.cwd));
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
  return { observations: [...byRootAndAgent.values()], droppedAgents };
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
