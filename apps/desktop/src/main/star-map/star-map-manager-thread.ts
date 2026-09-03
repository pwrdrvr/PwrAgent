import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AppServerBackendKind,
  NavigationThreadSummary,
  OpenStarMapManagerRequest,
  OpenStarMapManagerResponse,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  STAR_MAP_MANAGER_AGENT_INSTRUCTIONS,
  STAR_MAP_MANAGER_AGENT_NAME,
  STAR_MAP_MANAGER_THREAD_TITLE,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";

const log = getMainLogger("pwragent:star-map-manager");

/** PwrAgent-owned workspace; the manager is not a thread about a repository. */
const MANAGER_WORKSPACE_DIR = "star-map-manager";

/**
 * The manager's standing instructions reach the model through an instruction
 * file in its own workspace, not through the thread's `agent` metadata: that
 * metadata marks a thread as a persona thread for search and the Agents
 * browser, but nothing injects it into a turn.
 *
 * Written under every name the supported backends read, because there is no
 * single one. Codex and Claude take AGENTS.md and CLAUDE.md — the repository
 * pairs those two everywhere for the same reason — while the gemini-family
 * ACP backends (gemini, qwen) read their own. A manager whose backend does
 * not find this file starts with no persona at all: it would not know to
 * call read_star_map_view before acting, which is the multi-thread rename
 * these instructions exist to prevent.
 */
const MANAGER_AGENTS_MD = [
  `# ${STAR_MAP_MANAGER_AGENT_NAME}`,
  "",
  STAR_MAP_MANAGER_AGENT_INSTRUCTIONS,
  "",
  "<!--",
  "Written by PwrAgent when the Star Map manager thread is created, and",
  "rewritten whenever the manager is opened, so instruction changes that",
  "ship with an upgrade reach an existing manager thread. Edits made here",
  "by hand will be overwritten; put durable operator preferences in the",
  "profile's own AGENTS.md instead.",
  "-->",
  "",
].join("\n");

export type StarMapManagerDeps = {
  registry?: Pick<
    ReturnType<typeof getDesktopBackendRegistry>,
    "startThread" | "renameThread" | "listThreads"
  >;
  overlayStore?: Pick<
    ReturnType<typeof getDesktopOverlayStore>,
    "getStarMapManagerThread" | "setStarMapManagerThread" | "getLaunchpadDefaults"
  >;
  listThreadKeys?: () => Promise<Set<string>>;
  workspaceDir?: () => string;
};

/**
 * Resolve the operator's Star Map manager thread, creating it on first use.
 *
 * The manager is an ordinary thread: it gets the same tool catalog every
 * thread gets, so `mutate_thread` and the orchestration tools are already
 * in reach, and `read_star_map_view` lets it see what is on screen. What
 * this function owns is only identity — which thread the map's Manager
 * button reopens — and the workspace its instructions live in.
 */
export async function openStarMapManagerThread(
  request: OpenStarMapManagerRequest = {},
  deps: StarMapManagerDeps = {},
): Promise<OpenStarMapManagerResponse> {
  try {
    // Inside the try, and the registry only on the path that needs it: both
    // getters throw when app state is not initialized, and outside they
    // would reject the IPC invoke instead of returning the `failed` status
    // the caller's error path is written against.
    const overlayStore = deps.overlayStore ?? getDesktopOverlayStore();
    if (!request.reset) {
      const remembered = overlayStore.getStarMapManagerThread();
      if (remembered && (await threadStillExists(remembered, deps))) {
        // Best effort: an instruction refresh that cannot be written is not a
        // reason to withhold a thread that already exists and needs nothing
        // from the filesystem to reopen.
        await refreshManagerWorkspace(deps.workspaceDir);
        return {
          status: "ready",
          backend: remembered.backend,
          threadId: remembered.threadId,
          created: false,
        };
      }
    }
    // The create path genuinely needs the directory: it is the thread's cwd.
    const registry = deps.registry ?? getDesktopBackendRegistry();
    const workspace = await ensureManagerWorkspace(deps.workspaceDir);
    const defaults = await overlayStore.getLaunchpadDefaults();
    const started = await registry.startThread({
      backend: defaults.backend,
      executionMode: defaults.executionMode,
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      serviceTier: defaults.serviceTier,
      cwd: workspace,
      agent: {
        name: STAR_MAP_MANAGER_AGENT_NAME,
        instructions: STAR_MAP_MANAGER_AGENT_INSTRUCTIONS,
      },
    });
    try {
      await registry.renameThread({
        backend: started.backend,
        threadId: started.threadId,
        name: STAR_MAP_MANAGER_THREAD_TITLE,
      });
    } catch (error) {
      // A thread that exists under a generated title is still usable; losing
      // the whole manager over its name would be the worse outcome.
      log.warn("could not title the star map manager thread", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    overlayStore.setStarMapManagerThread({
      backend: started.backend,
      threadId: started.threadId,
    });
    return {
      status: "ready",
      backend: started.backend,
      threadId: started.threadId,
      created: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("star map manager thread unavailable", { error: message });
    return { status: "failed", error: message };
  }
}

async function refreshManagerWorkspace(
  workspaceDir?: () => string,
): Promise<void> {
  try {
    await ensureManagerWorkspace(workspaceDir);
  } catch (error) {
    log.warn("could not refresh the star map manager instructions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Instruction filenames the backends PwrAgent supports look for in a cwd.
 * Plain copies rather than symlinks: a symlink needs elevated privileges on
 * Windows, and these are generated files with one author.
 */
const MANAGER_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "QWEN.md",
] as const;

async function ensureManagerWorkspace(
  workspaceDir?: () => string,
): Promise<string> {
  const directory = workspaceDir?.() ?? resolveActiveProfilePath(MANAGER_WORKSPACE_DIR);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(
    MANAGER_INSTRUCTION_FILES.map(async (name) =>
      await fs.writeFile(path.join(directory, name), MANAGER_AGENTS_MD, "utf8"),
    ),
  );
  return directory;
}

/**
 * A remembered thread can be archived, or belong to a profile database that
 * moved on. Reopening a card onto a thread that no longer exists gives the
 * operator an empty transcript and no way to tell why, so check first and
 * create a fresh manager when the answer is no.
 */
async function threadStillExists(
  thread: { backend: string; threadId: string },
  deps: StarMapManagerDeps,
): Promise<boolean> {
  try {
    const keys =
      deps.listThreadKeys
        ? await deps.listThreadKeys()
        : await localThreadKeys(thread.backend, deps);
    return keys.has(
      buildThreadIdentityKey(
        thread.backend as NavigationThreadSummary["source"],
        thread.threadId,
      ),
    );
  } catch (error) {
    log.warn("could not verify the remembered manager thread", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Assume it is still there: reopening a stale card is recoverable, while
    // silently creating a second manager on every transient failure is not.
    return true;
  }
}

/**
 * Thread keys for one backend, straight from the registry.
 *
 * Deliberately not the navigation snapshot: that builds messaging bindings,
 * reconciles against SQLite and kicks off a Git working-state refresh across
 * every backend — a lot of work to answer one membership question while the
 * Manager button sits on "Opening…". The registry listing already overlays
 * threads it has started but the backend has not listed yet.
 */
async function localThreadKeys(
  backend: string,
  deps: StarMapManagerDeps,
): Promise<Set<string>> {
  const registry = deps.registry ?? getDesktopBackendRegistry();
  const threads = await registry.listThreads({
    backend: backend as AppServerBackendKind,
    callerReason: "star-map-manager-thread",
  });
  return new Set(
    threads
      // Archived threads stay in the listing — the map's own ⌘K palette
      // filters them out for the same reason. Counting one as still present
      // would reopen the manager card onto an archived thread rather than
      // starting the fresh one the operator is asking for.
      .filter((thread) => thread.archivedAt === undefined)
      .map((thread) =>
        buildThreadIdentityKey(
          backend as NavigationThreadSummary["source"],
          thread.id,
        ),
      ),
  );
}
