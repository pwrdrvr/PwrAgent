import type { NavigationThreadSummary, ThreadTodo } from "@pwragent/shared";
import type { WindowShowThreadRequest } from "../../../../shared/window-show-thread";
import type { DesktopApi } from "../../lib/desktop-api";
import { ensureWindowThreadMounted } from "../../lib/ensure-window-thread-mounted";

/**
 * The thread a handoff card started, as this window would mount it, or
 * nothing when it lives here.
 *
 * The card's owner records a start on a peer by that peer's id, and its own
 * start by none, so a viewer reads the owner from the card's target. A peer
 * id is compared with this machine's: the owner can start the thread here.
 * Without this machine's id that comparison cannot be made, so nothing is
 * mounted rather than this machine's own thread as a peer's.
 */
export function threadTodoStartedMountRequest(
  todo: Pick<ThreadTodo, "startedThread" | "federationTarget">,
  localInstanceId: string | undefined,
): WindowShowThreadRequest | undefined {
  const started = todo.startedThread;
  if (!started) return undefined;
  if (started.instanceId !== undefined && localInstanceId === undefined) return undefined;
  const instanceId = started.instanceId ?? todo.federationTarget?.instanceId;
  if (!instanceId || instanceId === localInstanceId) return undefined;
  return {
    backend: started.backend,
    threadId: started.threadId,
    federationTarget: { scope: "remote", instanceId },
  };
}

/**
 * Runs a card's action and mounts the thread it started in this window.
 *
 * The operator started that thread from here, so it belongs in this
 * window's lists like a fork or a launchpad thread made on a peer. Before
 * this, a Start thread on a peer's card left the new thread on the peer
 * only, reachable through the card's link. A remote viewer window already
 * lists its owner's threads and mounts nothing.
 *
 * The thread exists once the run resolves, so a failed mount is reported
 * and the run still succeeds: failing it would invite a duplicate start.
 */
export async function runThreadTodoAndMountStarted(
  run: () => Promise<ThreadTodo | undefined>,
  api: Pick<DesktopApi, "addRemoteThreadPin" | "hasRemoteThreadPin"> | undefined,
  context: {
    localInstanceId: string | undefined;
    isRemoteViewer: boolean;
    instanceLabel: (instanceId: string) => string | undefined;
  },
): Promise<ThreadTodo | undefined> {
  const todo = await run();
  const request = todo && !context.isRemoteViewer
    ? threadTodoStartedMountRequest(todo, context.localInstanceId)
    : undefined;
  if (!todo || !request || !api || !request.federationTarget) return todo;
  const instanceId = request.federationTarget.instanceId;
  const label = (todo.startedThread?.instanceId === instanceId ? todo.startedThread.instanceLabel : undefined)
    ?? context.instanceLabel(instanceId);
  // Until the owner's snapshot arrives, the row is named for the card rather
  // than by its thread id. Its parent is left to that snapshot: a start for
  // another project is not grouped, and the card does not say which it was.
  const summary: NavigationThreadSummary = {
    source: request.backend,
    id: request.threadId,
    title: (todo.action?.type === "start_thread" ? todo.action.title : undefined) ?? todo.title,
    titleSource: "fallback",
    linkedDirectories: [],
    inbox: { inInbox: false },
  };
  try {
    // Loaded rows only speed up the check; the persisted membership decides.
    await ensureWindowThreadMounted(api, request, [], false, label, summary);
  } catch (error) {
    console.warn("Could not add the started thread to this thread list:", error);
  }
  return todo;
}
