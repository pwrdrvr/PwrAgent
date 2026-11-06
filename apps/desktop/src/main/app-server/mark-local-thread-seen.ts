import type {
  AppServerBackendKind,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
} from "@pwragent/shared";
import {
  getDesktopBackendRegistry,
  getExistingDesktopBackendRegistry,
} from "./backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";

/**
 * Marks a thread this desktop owns as seen, for its own window or for a peer.
 * The write waits for the thread's lifecycle mutations, and the
 * `navigation/thread/seen` it announces reaches every window and every
 * subscribed viewer, so a mark made from one place shows in all of them.
 */
export async function markLocalThreadSeen(
  request: Omit<MarkThreadSeenRequest, "backend" | "federationTarget"> & { backend: AppServerBackendKind },
): Promise<MarkThreadSeenResponse> {
  const { backend, threadId, seenAt, seenUpdatedAt } = request;
  const markSeen = async () => await getDesktopOverlayStore().markThreadSeen({
    backend,
    seenAt,
    seenUpdatedAt,
    threadId,
  });
  const registry = getExistingDesktopBackendRegistry();
  const response = registry
    ? await registry.withThreadLifecycleMutation({ backend, threadId }, markSeen)
    : await markSeen();
  await getDesktopBackendRegistry().publishLocalEvent({ backend, notification: {
    method: "navigation/thread/seen", params: { threadId, seenUpdatedAt },
  } });
  return response;
}
