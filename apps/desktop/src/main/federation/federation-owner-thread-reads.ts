import type {
  AppServerBackendKind,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { materializeTranscriptImageUrlsForRenderer } from "../transcript-image-protocol";

/** The registry reads an owner answers a peer's transcript requests with. */
export type FederationOwnerThreadReadRegistry = Pick<
  DesktopBackendRegistry,
  "getThreadTranscriptImageRoots" | "readThread"
>;

/**
 * Owner-local images in a peer's read become `pwragent-image://` URLs this
 * owner serves through `backend.readTranscriptImage`. Markdown-linked files
 * live on this machine's disk, so only the owner can materialize them.
 */
export async function materializeTranscriptImagesForPeer(
  registry: FederationOwnerThreadReadRegistry,
  thread: { backend: AppServerBackendKind; threadId: string },
  response: AppServerReadThreadResponse,
): Promise<AppServerReadThreadResponse> {
  return await materializeTranscriptImageUrlsForRenderer(response, {}, {
    includeTemporaryImageRoots: true,
    resolveApprovedLocalImageRoots: () => registry.getThreadTranscriptImageRoots({
      backend: thread.backend,
      threadId: thread.threadId,
    }),
  });
}

/** A peer's `backend.readThread`, answered from this owner's registry. */
export async function readThreadForPeer(
  registry: FederationOwnerThreadReadRegistry,
  request: AppServerReadThreadRequest,
): Promise<AppServerReadThreadResponse> {
  const backend = request.backend ?? "codex";
  const response = await registry.readThread({
    backend,
    display: request.display,
    threadId: request.threadId,
    ...(request.includeTurns !== undefined
      ? { includeTurns: request.includeTurns }
      : {}),
    ...(request.includeAllToolInvocations !== undefined
      ? { includeAllToolInvocations: request.includeAllToolInvocations }
      : {}),
    before: request.before,
    limit: request.limit,
    ...(request.viewOnly !== undefined
      ? { viewOnly: request.viewOnly }
      : {}),
  });
  return await materializeTranscriptImagesForPeer(
    registry,
    { backend, threadId: request.threadId },
    response,
  );
}
