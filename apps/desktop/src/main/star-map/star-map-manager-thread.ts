import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AppServerBackendKind,
  OpenStarMapManagerRequest,
  OpenStarMapManagerResponse,
} from "@pwragent/shared";
import {
  STAR_MAP_MANAGER_AGENT_INSTRUCTIONS,
  STAR_MAP_MANAGER_AGENT_NAME,
  STAR_MAP_MANAGER_THREAD_TITLE,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";

const log = getMainLogger("pwragent:star-map-manager");

/** PwrAgent-owned workspace; the manager is not a thread about a repository. */
const MANAGER_WORKSPACE_DIR = "star-map-manager";

/**
 * The manager's standing instructions reach the model through an AGENTS.md
 * in its own workspace, not through the thread's `agent` metadata: that
 * metadata marks a thread as a persona thread for search and the Agents
 * browser, but nothing injects it into a turn. Every backend PwrAgent
 * supports reads AGENTS.md from its cwd, so this is the one mechanism that
 * works for all of them — and it stays visible and editable to the operator.
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
    "startThread" | "renameThread"
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
 * in reach, and the two star-map tools let it see what is on screen. What
 * this function owns is only identity — which thread the map's Manager
 * button reopens — and the workspace its instructions live in.
 */
export async function openStarMapManagerThread(
  request: OpenStarMapManagerRequest = {},
  deps: StarMapManagerDeps = {},
): Promise<OpenStarMapManagerResponse> {
  const overlayStore = deps.overlayStore ?? getDesktopOverlayStore();
  const registry = deps.registry ?? getDesktopBackendRegistry();
  try {
    const workspace = await ensureManagerWorkspace(deps.workspaceDir);
    if (!request.reset) {
      const remembered = overlayStore.getStarMapManagerThread();
      if (remembered && (await threadStillExists(remembered, deps))) {
        return {
          status: "ready",
          backend: remembered.backend,
          threadId: remembered.threadId,
          created: false,
        };
      }
    }
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

async function ensureManagerWorkspace(
  workspaceDir?: () => string,
): Promise<string> {
  const directory = workspaceDir?.() ?? resolveActiveProfilePath(MANAGER_WORKSPACE_DIR);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "AGENTS.md"),
    MANAGER_AGENTS_MD,
    "utf8",
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
        : await localThreadKeys();
    return keys.has(`${thread.backend}:${thread.threadId}`);
  } catch (error) {
    log.warn("could not verify the remembered manager thread", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Assume it is still there: reopening a stale card is recoverable, while
    // silently creating a second manager on every transient failure is not.
    return true;
  }
}

async function localThreadKeys(): Promise<Set<string>> {
  const snapshot = await new DesktopMessagingBackendBridge().getNavigationSnapshot(
    {},
  );
  return new Set(
    snapshot.threads.map(
      (thread: { source: AppServerBackendKind; id: string }) =>
        `${thread.source}:${thread.id}`,
    ),
  );
}
