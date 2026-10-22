import type { NavigationThreadSummary } from "@pwragent/shared";
import type { WindowShowThreadRequest } from "../../../shared/window-show-thread";
import type { DesktopApi } from "./desktop-api";

/** Reuse a mounted peer row; opening it again should not persist another pin. */
export async function ensureWindowThreadMounted(
  api: Pick<DesktopApi, "addRemoteThreadPin">,
  request: WindowShowThreadRequest,
  threads: readonly NavigationThreadSummary[],
  isRemoteViewer: boolean,
): Promise<void> {
  const target = request.federationTarget;
  if (!target || isRemoteViewer || threads.some((thread) =>
    thread.source === request.backend && thread.id === request.threadId
    && thread.federation?.ref.target.scope === "remote"
    && thread.federation.ref.target.instanceId === target.instanceId)) return;
  if (!api.addRemoteThreadPin) throw new Error("This window cannot mount remote threads.");
  await api.addRemoteThreadPin({
    ref: { backend: request.backend, threadId: request.threadId, target },
  });
}
