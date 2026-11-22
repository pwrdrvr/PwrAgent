import { realpath } from "node:fs/promises";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DiscoverRecentProjectsResponse,
  RecentProjectAgent,
  RecentProjectObservation,
  RecentProjectSourceReport,
} from "@pwragent/shared/contracts/settings";
import { canonicalizeNavigationPath, navigationPathIdentity } from "@pwragent/shared/directory-navigation";

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
  platform: NodeJS.Platform;
  /** Test seam for the on-disk spelling of a resolved project root. */
  realpath?: (path: string) => Promise<string>;
  /** Aborted when a newer discovery replaces this one; no more folders are checked. */
  signal?: AbortSignal;
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

/** The App Server calls one Codex read makes. */
export type RecentCodexDirectoryClient = {
  listRecentThreadDirectories(params: {
    limit: number;
    maxPages: number;
    deadlineAt?: number;
  }): Promise<RecentCodexDirectories>;
  close(): Promise<void>;
};

/**
 * Reads Codex's recent thread folders from a one-off App Server, and closes
 * it when the read ends or `signal` aborts, whichever comes first. Closing
 * stops the `thread/list` pages still to come.
 */
export async function readRecentCodexDirectories(
  createClient: () => RecentCodexDirectoryClient,
  params: { deadlineAt?: number; signal?: AbortSignal },
): Promise<RecentCodexDirectories> {
  const { signal } = params;
  signal?.throwIfAborted();
  const client = createClient();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= client.close().catch(() => undefined));
  try {
    const read = client.listRecentThreadDirectories({
      limit: RECENT_PROJECT_CODEX_PAGE_SIZE,
      maxPages: RECENT_PROJECT_CODEX_MAX_PAGES,
      deadlineAt: params.deadlineAt,
    });
    if (!signal) return await read;
    // Settled below or abandoned on abort; either way never unhandled.
    read.catch(() => undefined);
    return await new Promise<RecentCodexDirectories>((resolve, reject) => {
      const onAbort = (): void => {
        void close();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void read.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  } finally {
    await close();
  }
}

/**
 * One discovery per window. A newer request from the same window aborts the
 * one before it: React runs Get started's effect twice on mount in
 * development, and changing the Codex login choice asks again, and the
 * renderer keeps only the newest answer. A window that closes cancels its
 * search.
 */
export class RecentProjectDiscoveryRuns {
  private readonly current = new Map<number, AbortController>();

  /** Aborts `owner`'s search, if one is running. */
  cancel(owner: number, reason = "The window that asked for recent projects closed."): void {
    this.current.get(owner)?.abort(new Error(reason));
    this.current.delete(owner);
  }

  async run<T>(owner: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.cancel(owner, "A newer search for recent projects replaced this one.");
    const controller = new AbortController();
    this.current.set(owner, controller);
    try {
      return await work(controller.signal);
    } finally {
      if (this.current.get(owner) === controller) this.current.delete(owner);
    }
  }
}

/**
 * On Windows and macOS, `folder` as the disk spells it, whichever case an
 * agent used. Only letter case is taken from the disk: a mapped drive,
 * junction or link to another path keeps the reported path.
 */
export async function folderInRealCase(
  folder: string,
  realpath: (path: string) => Promise<string>,
): Promise<string> {
  const real = await realpath(folder).then(canonicalizeNavigationPath, () => undefined);
  return real && navigationPathIdentity(real, true) === navigationPathIdentity(folder, true) ? real : folder;
}

/**
 * Recent project folders for Get started, with how each agent's read went.
 * Nothing here reads an agent's own storage: Codex answers through its
 * protocol, and Claude Code and ACP agents through PwrAgent's thread lists.
 * Main takes the spelling of the registered root from disk where case can
 * vary. Ranking, prechecking and merging the same folder from two agents
 * happen in the renderer
 * (`get-started-projects.ts`).
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

  const { platform } = deps;
  const canonicalizeRootCase = platform === "win32" || platform === "darwin";
  const { observations, droppedAgents, probed } = await resolveObservations(raw, {
    // macOS volumes can have different case rules. Compare their on-disk
    // root spellings exactly so App and app can remain distinct.
    identity: (path) => navigationPathIdentity(path, platform === "win32"),
    resolveProjectRoot: async (folder) => {
      const root = await deps.resolveProjectRoot(folder);
      return root && canonicalizeRootCase ? await folderInRealCase(root, deps.realpath ?? realpath) : root;
    },
    signal: deps.signal,
  });
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
 * a folder that was never checked. Folders and roots are matched by
 * `identity`; a root is sent as the spelling its newest folder resolved to.
 */
async function resolveObservations(
  raw: readonly RawObservation[],
  { identity, resolveProjectRoot, signal }: {
    identity: (path: string) => string;
    resolveProjectRoot: (path: string) => Promise<string | undefined>;
    signal?: AbortSignal;
  },
): Promise<{
  observations: RecentProjectObservation[];
  droppedAgents: Set<RecentProjectAgent>;
  probed: number;
}> {
  const newestByFolder = new Map<string, { cwd: string; newest: number }>();
  for (const observation of raw) {
    const key = identity(observation.cwd);
    if (!key) continue;
    const time = observation.lastActiveAt ?? Number.NEGATIVE_INFINITY;
    const existing = newestByFolder.get(key);
    // Equal times keep the smaller spelling, so the folder checked does not
    // depend on which agent answered first.
    if (
      !existing
      || time > existing.newest
      || (time === existing.newest && observation.cwd < existing.cwd)
    ) {
      newestByFolder.set(key, { cwd: observation.cwd, newest: time });
    }
  }
  const ordered = [...newestByFolder.entries()]
    .sort(([leftKey, left], [rightKey, right]) => right.newest - left.newest || leftKey.localeCompare(rightKey));

  /** Folder identity to root identity, or undefined when the folder is gone. */
  const roots = new Map<string, string | undefined>();
  /** Root identity to the spelling sent to the renderer. */
  const distinctRoots = new Map<string, string>();
  /** Folders whose project was never listed: unchecked, or past the cap. */
  const droppedKeys = new Set<string>();
  let probed = 0;
  // Batches keep the newest-first order: a later batch starts only while
  // fewer than the cap of projects has been found.
  while (
    probed < ordered.length
    && probed < RECENT_PROJECT_MAX_FOLDERS
    && distinctRoots.size < RECENT_PROJECT_MAX_PROJECTS
    && !signal?.aborted
  ) {
    const batch = ordered.slice(probed, Math.min(probed + RESOLVE_CONCURRENCY, RECENT_PROJECT_MAX_FOLDERS));
    probed += batch.length;
    const resolved = await Promise.all(batch.map(async ([, { cwd }]) => await resolveProjectRoot(cwd).catch(() => undefined)));
    for (const [index, [key]] of batch.entries()) {
      const root = resolved[index];
      const rootKey = root ? identity(root) || undefined : undefined;
      // A batch can cross the cap; the newest roots in it are kept.
      if (rootKey && !distinctRoots.has(rootKey) && distinctRoots.size >= RECENT_PROJECT_MAX_PROJECTS) {
        droppedKeys.add(key);
        continue;
      }
      roots.set(key, rootKey);
      if (root && rootKey && !distinctRoots.has(rootKey)) distinctRoots.set(rootKey, root);
    }
  }

  for (const [key] of ordered.slice(probed)) droppedKeys.add(key);

  const droppedAgents = new Set<RecentProjectAgent>();
  const byRootAndAgent = new Map<string, RecentProjectObservation>();
  for (const observation of raw) {
    const key = identity(observation.cwd);
    if (!key) continue;
    if (droppedKeys.has(key)) {
      droppedAgents.add(observation.agent);
      continue;
    }
    const rootKey = roots.get(key);
    const root = rootKey && distinctRoots.get(rootKey);
    if (!rootKey || !root) continue;
    const id = JSON.stringify([observation.agent, rootKey]);
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
